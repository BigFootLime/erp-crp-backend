import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { HttpError } from "../../../utils/httpError";
import type { ParsedTabularFile, ParsedTabularSheet } from "../types/import-assistant.types";

const MAX_ROWS = 100_000;
const MAX_COLUMNS = 300;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_SHEETS = 50;

type ZipEntry = { name: string; compression: number; compressedSize: number; uncompressedSize: number; dataOffset: number };

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function parseZipEntries(buffer: Buffer): Map<string, ZipEntry> {
  let eocd = -1;
  const min = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new HttpError(400, "INVALID_XLSX", "Le fichier Excel n’est pas une archive XLSX valide.");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  let offset = centralOffset;
  let expandedTotal = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new HttpError(400, "INVALID_XLSX", "Le répertoire interne du classeur est invalide.");
    }
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replace(/\\/g, "/");

    if (offset + 46 + nameLength + extraLength + commentLength > buffer.length) {
      throw new HttpError(400, "INVALID_XLSX", "Une entrée du classeur dépasse la taille du fichier.");
    }
    if (name.startsWith("/") || name.includes("../")) {
      throw new HttpError(400, "INVALID_XLSX_PATH", "Le classeur contient un chemin interne interdit.");
    }
    expandedTotal += uncompressedSize;
    if (expandedTotal > MAX_UNCOMPRESSED_BYTES) {
      throw new HttpError(413, "XLSX_EXPANDED_TOO_LARGE", "Le contenu décompressé du classeur dépasse 64 Mo.");
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > 200) {
      throw new HttpError(400, "XLSX_COMPRESSION_RATIO", "Le taux de compression du classeur est anormal.");
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new HttpError(400, "INVALID_XLSX", "Une entrée locale du classeur est invalide.");
    }
    const fileNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + fileNameLength + localExtraLength;
    if (dataOffset + compressedSize > buffer.length) {
      throw new HttpError(400, "INVALID_XLSX", "Le contenu d’une entrée du classeur est tronqué.");
    }
    entries.set(name, { name, compression, compressedSize, uncompressedSize, dataOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer: Buffer, entries: Map<string, ZipEntry>, name: string): Buffer {
  const entry = entries.get(name);
  if (!entry) throw new HttpError(400, "INVALID_XLSX_PART", `Partie XLSX manquante : ${name}`);
  const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.compression === 0) return compressed;
  if (entry.compression === 8) {
    const expanded = inflateRawSync(compressed, { maxOutputLength: Math.min(entry.uncompressedSize + 1024, MAX_UNCOMPRESSED_BYTES) });
    if (expanded.length !== entry.uncompressedSize) {
      throw new HttpError(400, "INVALID_XLSX_SIZE", "La taille décompressée du classeur est incohérente.");
    }
    return expanded;
  }
  throw new HttpError(400, "UNSUPPORTED_XLSX_COMPRESSION", "Le classeur utilise une compression Excel non prise en charge.");
}

function columnIndex(cellRef: string): number {
  const letters = /^[A-Z]+/i.exec(cellRef)?.[0]?.toUpperCase() ?? "";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return Math.max(0, index - 1);
}

function uniqueHeaders(values: unknown[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value, index) => {
    const raw = String(value ?? "").trim() || `COLONNE_${index + 1}`;
    const count = (seen.get(raw) ?? 0) + 1;
    seen.set(raw, count);
    return count === 1 ? raw : `${raw}_${count}`;
  });
}

function parseSharedStrings(xml: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const parts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1]));
    values.push(parts.join(""));
  }
  return values;
}

function parseDateStyleIndexes(stylesXml: string | null): Set<number> {
  if (!stylesXml) return new Set();
  const customFormats = new Map<number, string>();
  for (const match of stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/?>/g)) {
    customFormats.set(Number(match[1]), decodeXml(match[2]));
  }
  const dateStyles = new Set<number>();
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
  let index = 0;
  for (const match of cellXfs.matchAll(/<xf\b([^>]*)\/?>/g)) {
    const numFmtId = Number(/numFmtId="(\d+)"/.exec(match[1])?.[1] ?? 0);
    const format = customFormats.get(numFmtId) ?? "";
    if ((numFmtId >= 14 && numFmtId <= 22) || /[ymdhis]/i.test(format.replace(/\[[^\]]+\]/g, ""))) {
      dateStyles.add(index);
    }
    index += 1;
  }
  return dateStyles;
}

function excelDate(serial: number): string {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + serial * 86_400_000).toISOString().slice(0, 10);
}

function parseSheetXml(
  name: string,
  xml: string,
  sharedStrings: string[],
  dateStyles: Set<number>
): ParsedTabularSheet {
  const matrix: unknown[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (matrix.length >= MAX_ROWS + 1) throw new HttpError(413, "TOO_MANY_ROWS", `La feuille ${name} dépasse ${MAX_ROWS} lignes.`);
    const row: unknown[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const content = cellMatch[2];
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1] ?? `A${matrix.length + 1}`;
      const index = columnIndex(ref);
      if (index >= MAX_COLUMNS) throw new HttpError(413, "TOO_MANY_COLUMNS", `La feuille ${name} dépasse ${MAX_COLUMNS} colonnes.`);
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const styleIndex = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1);
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(content)?.[1] ?? "";
      const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(content)?.[1] ?? "";
      let value: unknown = null;
      if (type === "s") value = sharedStrings[Number(raw)] ?? "";
      else if (type === "inlineStr") value = [...inline.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join("");
      else if (type === "b") value = raw === "1";
      else if (type === "str" || type === "e") value = decodeXml(raw);
      else if (raw !== "") {
        const number = Number(raw);
        value = Number.isFinite(number) ? (dateStyles.has(styleIndex) ? excelDate(number) : number) : decodeXml(raw);
      }
      row[index] = value;
    }
    matrix.push(row);
  }
  const headerRow = matrix.shift() ?? [];
  const headers = uniqueHeaders(headerRow);
  const rows = matrix
    .filter((row) => row.some((value) => value !== null && String(value).trim() !== ""))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, (row[index] ?? null) as string | number | boolean | null])));
  return { name, headers, rows };
}

function resolvePart(base: string, target: string): string {
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(base), target));
  if (normalized.startsWith("../") || normalized.startsWith("/")) throw new HttpError(400, "INVALID_XLSX_PATH", "Chemin de feuille XLSX interdit.");
  return normalized;
}

function parseXlsx(buffer: Buffer): ParsedTabularFile {
  const entries = parseZipEntries(buffer);
  const workbookPath = entries.has("xl/workbook.xml") ? "xl/workbook.xml" : "";
  if (!workbookPath) throw new HttpError(400, "INVALID_XLSX", "Le classeur ne contient pas xl/workbook.xml.");
  const workbookXml = readZipEntry(buffer, entries, workbookPath).toString("utf8");
  const relsPath = "xl/_rels/workbook.xml.rels";
  const relsXml = readZipEntry(buffer, entries, relsPath).toString("utf8");
  const rels = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[1])?.[1];
    if (id && target) rels.set(id, resolvePart(workbookPath, decodeXml(target)));
  }

  const sharedStrings = entries.has("xl/sharedStrings.xml")
    ? parseSharedStrings(readZipEntry(buffer, entries, "xl/sharedStrings.xml").toString("utf8"))
    : [];
  const dateStyles = parseDateStyleIndexes(
    entries.has("xl/styles.xml") ? readZipEntry(buffer, entries, "xl/styles.xml").toString("utf8") : null
  );
  const sheets: ParsedTabularSheet[] = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    if (sheets.length >= MAX_SHEETS) throw new HttpError(413, "TOO_MANY_SHEETS", `Le classeur dépasse ${MAX_SHEETS} feuilles.`);
    const name = decodeXml(/\bname="([^"]+)"/.exec(match[1])?.[1] ?? `Feuille ${sheets.length + 1}`);
    const relationId = /\br:id="([^"]+)"/.exec(match[1])?.[1];
    const sheetPath = relationId ? rels.get(relationId) : null;
    if (!sheetPath || !entries.has(sheetPath)) continue;
    sheets.push(parseSheetXml(name, readZipEntry(buffer, entries, sheetPath).toString("utf8"), sharedStrings, dateStyles));
  }
  if (sheets.length === 0) throw new HttpError(400, "EMPTY_WORKBOOK", "Le classeur ne contient aucune feuille lisible.");
  return { sheets };
}

function decodeCsvBuffer(buffer: Buffer): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (!utf8.includes("\uFFFD")) return utf8.replace(/^\uFEFF/, "");
  return new TextDecoder("windows-1252").decode(buffer).replace(/^\uFEFF/, "");
}

function detectDelimiter(firstLine: string): string {
  const candidates = [";", ",", "\t"];
  return candidates
    .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter ?? ";";
}

function parseCsv(buffer: Buffer, name: string): ParsedTabularFile {
  const text = decodeCsvBuffer(buffer);
  const delimiter = detectDelimiter(text.split(/\r?\n/, 1)[0] ?? "");
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else value += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
      if (rows.length > MAX_ROWS + 1) throw new HttpError(413, "TOO_MANY_ROWS", `Le fichier CSV dépasse ${MAX_ROWS} lignes.`);
    } else value += char;
  }
  if (value !== "" || row.length > 0) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers = uniqueHeaders(rows.shift() ?? []);
  if (headers.length > MAX_COLUMNS) throw new HttpError(413, "TOO_MANY_COLUMNS", `Le fichier CSV dépasse ${MAX_COLUMNS} colonnes.`);
  const records = rows
    .filter((values) => values.some((cell) => cell.trim() !== ""))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() || null])));
  return { sheets: [{ name, headers, rows: records }] };
}

export function parseTabularFile(file: Express.Multer.File): ParsedTabularFile {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension === ".csv") return parseCsv(file.buffer, path.basename(file.originalname, extension));
  if (extension === ".xlsx") return parseXlsx(file.buffer);
  throw new HttpError(400, "UNSUPPORTED_IMPORT_FORMAT", "Format refusé. Utilisez un fichier .xlsx ou .csv.");
}
