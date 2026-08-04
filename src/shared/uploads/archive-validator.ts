import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { crc32 } from "node:zlib";

import sax from "sax";
import {
  fromBufferPromise,
  openPromise,
  parseExtraFields,
  type Entry,
  type LocalFileHeader,
  type ZipFile,
} from "yauzl";

const MIB = 1024 * 1024;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const AES_EXTRA_FIELD_ID = 0x9901;
const MAX_EOCD_SEARCH_BYTES = 22 + 0xffff + 20;

export const ARCHIVE_VALIDATION_LIMITS = Object.freeze({
  maxFileBytes: 64 * MIB,
  maxEntries: 2_048,
  maxCentralDirectoryBytes: 4 * MIB,
  maxArchiveCommentBytes: 1_024,
  maxEntryNameBytes: 512,
  maxEntryCommentBytes: 1_024,
  maxEntryExtraBytes: 65_535,
  maxPathDepth: 32,
  maxEntryCompressedBytes: 64 * MIB,
  maxEntryUncompressedBytes: 128 * MIB,
  maxTotalCompressedBytes: 64 * MIB,
  maxTotalUncompressedBytes: 256 * MIB,
  maxCompressionRatio: 200,
  maxInspectedXmlBytes: 1 * MIB,
  maxXmlElements: 4_096,
  maxXmlAttributesPerElement: 32,
  maxMainXmlElements: 250_000,
  maxMainXmlAttributesPerElement: 64,
});

export const STRUCTURAL_ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".3mf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".odt",
  ".ods",
] as const);

export type StructuralArchiveExtension = ".zip" | ".3mf" | ".docx" | ".xlsx" | ".pptx" | ".odt" | ".ods";

export type ArchiveValidationSource = Readonly<{
  buffer?: Buffer;
  path?: string;
  size: number;
}>;

type EocdRecord = Readonly<{
  offset: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  entryCount: number;
}>;

type ValidatedEntry = Readonly<{
  name: string;
  isDirectory: boolean;
  compressionMethod: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  localExtraFieldLength: number;
}>;

type XmlElement = Readonly<{
  localName: string;
  namespaceUri: string;
  attributes: Readonly<Record<string, string>>;
}>;

type MainXmlExpectation = Readonly<{
  entryName: string;
  rootLocalName: string;
  rootNamespaceUris: readonly string[];
}>;

const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const ODF_MANIFEST_NAMESPACE = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";

const OOXML_CONTENT_TYPES = Object.freeze({
  ".docx": {
    mainEntry: "word/document.xml",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    rootLocalName: "document",
    rootNamespaceUris: [
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
      "http://purl.oclc.org/ooxml/wordprocessingml/main",
    ],
  },
  ".xlsx": {
    mainEntry: "xl/workbook.xml",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    rootLocalName: "workbook",
    rootNamespaceUris: [
      "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "http://purl.oclc.org/ooxml/spreadsheetml/main",
    ],
  },
  ".pptx": {
    mainEntry: "ppt/presentation.xml",
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    rootLocalName: "presentation",
    rootNamespaceUris: [
      "http://schemas.openxmlformats.org/presentationml/2006/main",
      "http://purl.oclc.org/ooxml/presentationml/main",
    ],
  },
} as const);

const ODF_MEDIA_TYPES = Object.freeze({
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
} as const);

function archiveSourceIsValid(source: ArchiveValidationSource): boolean {
  if (!Number.isSafeInteger(source.size) || source.size < 22 || source.size > ARCHIVE_VALIDATION_LIMITS.maxFileBytes) {
    return false;
  }
  if (source.buffer) return source.buffer.length === source.size && !source.path;
  return typeof source.path === "string" && source.path.length > 0;
}

async function readArchiveTail(source: ArchiveValidationSource): Promise<Buffer> {
  const length = Math.min(source.size, MAX_EOCD_SEARCH_BYTES);
  if (source.buffer) return source.buffer.subarray(source.buffer.length - length);
  if (!source.path) throw new Error("archive source missing");

  const handle = await fs.open(source.path, "r");
  try {
    const tail = Buffer.alloc(length);
    const result = await handle.read(tail, 0, length, source.size - length);
    if (result.bytesRead !== length) throw new Error("truncated archive tail");
    return tail;
  } finally {
    await handle.close();
  }
}

async function readArchiveRange(source: ArchiveValidationSource, start: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > source.size) {
    throw new Error("invalid archive range");
  }
  if (source.buffer) return source.buffer.subarray(start, start + length);
  if (!source.path) throw new Error("archive source missing");

  const handle = await fs.open(source.path, "r");
  try {
    const value = Buffer.alloc(length);
    const result = await handle.read(value, 0, length, start);
    if (result.bytesRead !== length) throw new Error("truncated archive range");
    return value;
  } finally {
    await handle.close();
  }
}

function parseBoundedEocd(tail: Buffer, fileSize: number): EocdRecord | null {
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== ZIP_EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + 22 + commentLength !== tail.length) continue;
    if (commentLength > ARCHIVE_VALIDATION_LIMITS.maxArchiveCommentBytes) return null;

    const diskNumber = tail.readUInt16LE(index + 4);
    const centralDirectoryDisk = tail.readUInt16LE(index + 6);
    const entriesOnDisk = tail.readUInt16LE(index + 8);
    const entryCount = tail.readUInt16LE(index + 10);
    const centralDirectorySize = tail.readUInt32LE(index + 12);
    const centralDirectoryOffset = tail.readUInt32LE(index + 16);
    const eocdOffset = fileSize - tail.length + index;

    const hasZip64Locator = index >= 20 && tail.readUInt32LE(index - 20) === ZIP64_EOCD_LOCATOR_SIGNATURE;
    if (
      hasZip64Locator
      || diskNumber !== 0
      || centralDirectoryDisk !== 0
      || entriesOnDisk !== entryCount
      || entryCount === 0xffff
      || centralDirectorySize === 0xffffffff
      || centralDirectoryOffset === 0xffffffff
      || entryCount > ARCHIVE_VALIDATION_LIMITS.maxEntries
      || centralDirectorySize > ARCHIVE_VALIDATION_LIMITS.maxCentralDirectoryBytes
      || centralDirectoryOffset + centralDirectorySize !== eocdOffset
    ) {
      return null;
    }

    return { offset: eocdOffset, centralDirectoryOffset, centralDirectorySize, entryCount };
  }
  return null;
}

function pathIsSafe(fileName: string, rawLength: number): boolean {
  if (
    rawLength === 0
    || rawLength > ARCHIVE_VALIDATION_LIMITS.maxEntryNameBytes
    || fileName.length === 0
    || fileName.includes("\\")
    || fileName.includes("\0")
    || /[\u0000-\u001f\u007f]/u.test(fileName)
    || fileName.startsWith("/")
    || /^[a-z]:/iu.test(fileName)
    || fileName.normalize("NFC") !== fileName
  ) {
    return false;
  }

  const pathWithoutDirectorySuffix = fileName.endsWith("/") ? fileName.slice(0, -1) : fileName;
  const segments = pathWithoutDirectorySuffix.split("/");
  return (
    pathWithoutDirectorySuffix.length > 0
    && segments.length <= ARCHIVE_VALIDATION_LIMITS.maxPathDepth
    && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function entryFlagsAreSupported(entry: Entry): boolean {
  if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x2041) !== 0) return false;
  const allowedFlags = entry.compressionMethod === 8 ? 0x080e : 0x0808;
  return (entry.generalPurposeBitFlag & ~allowedFlags) === 0;
}

function entryTypeIsSafe(entry: Entry, isDirectory: boolean): boolean {
  const creatorPlatform = entry.versionMadeBy >>> 8;
  if (creatorPlatform !== 3) return true;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0xf000;
  if (fileType === 0) return true;
  return isDirectory ? fileType === 0x4000 : fileType === 0x8000;
}

function extraFieldsAreSupported(entry: Entry, localHeader: LocalFileHeader): boolean {
  if (entry.extraFieldLength > ARCHIVE_VALIDATION_LIMITS.maxEntryExtraBytes) return false;
  const localExtraFields = parseExtraFields(localHeader.extraField);
  return ![...entry.extraFields, ...localExtraFields]
    .some((field) => field.id === ZIP64_EXTRA_FIELD_ID || field.id === AES_EXTRA_FIELD_ID);
}

function localHeaderMatchesCentralDirectory(entry: Entry, localHeader: LocalFileHeader): boolean {
  if (
    localHeader.versionNeededToExtract > 20
    || localHeader.generalPurposeBitFlag !== entry.generalPurposeBitFlag
    || localHeader.compressionMethod !== entry.compressionMethod
    || !localHeader.fileName.equals(entry.fileNameRaw)
  ) {
    return false;
  }

  const usesDataDescriptor = (entry.generalPurposeBitFlag & 0x0008) !== 0;
  if (!usesDataDescriptor) {
    return (
      localHeader.crc32 === entry.crc32
      && localHeader.compressedSize === entry.compressedSize
      && localHeader.uncompressedSize === entry.uncompressedSize
    );
  }

  return (
    (localHeader.crc32 === 0 || localHeader.crc32 === entry.crc32)
    && (localHeader.compressedSize === 0 || localHeader.compressedSize === entry.compressedSize)
    && (localHeader.uncompressedSize === 0 || localHeader.uncompressedSize === entry.uncompressedSize)
  );
}

function createMainXmlStreamValidator(expectation: MainXmlExpectation): Readonly<{
  write(chunk: Buffer): void;
  finish(): void;
}> {
  const decoder = new StringDecoder("utf8");
  const parser = sax.parser(true, { xmlns: true, trim: false, normalize: false });
  let rootSeen = false;
  let elementCount = 0;

  parser.onerror = (error) => { throw error; };
  parser.ondoctype = () => { throw new Error("DOCTYPE is forbidden in package content"); };
  parser.onopentag = (node) => {
    const qualifiedNode = node as typeof node & { local: string; uri: string };
    elementCount += 1;
    if (elementCount > ARCHIVE_VALIDATION_LIMITS.maxMainXmlElements) {
      throw new Error("package content has too many XML elements");
    }
    if (Object.keys(node.attributes).length > ARCHIVE_VALIDATION_LIMITS.maxMainXmlAttributesPerElement) {
      throw new Error("package content has too many XML attributes");
    }
    if (!rootSeen) {
      rootSeen = true;
      if (
        qualifiedNode.local !== expectation.rootLocalName
        || !expectation.rootNamespaceUris.includes(qualifiedNode.uri)
      ) {
        throw new Error("package content root does not match its archive type");
      }
    }
  };

  const writeText = (text: string) => {
    if (text.includes("\ufffd")) throw new Error("package content is not valid UTF-8 XML");
    if (text.length > 0) parser.write(text);
  };
  return {
    write(chunk) {
      writeText(decoder.write(chunk));
    },
    finish() {
      writeText(decoder.end());
      parser.close();
      if (!rootSeen) throw new Error("package content has no XML root");
    },
  };
}

async function readAndVerifyEntry(
  zipFile: ZipFile,
  entry: Entry,
  capture: boolean,
  mainXmlExpectation: MainXmlExpectation | null,
  signal: AbortSignal
): Promise<Buffer | null> {
  if (signal.aborted) throw new Error("archive validation aborted");
  if (capture && entry.uncompressedSize > ARCHIVE_VALIDATION_LIMITS.maxInspectedXmlBytes) {
    throw new Error("archive package metadata exceeds inspection limit");
  }

  const stream = await zipFile.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  const mainXmlValidator = mainXmlExpectation ? createMainXmlStreamValidator(mainXmlExpectation) : null;
  let actualSize = 0;
  let calculatedCrc = 0;
  const abort = () => stream.destroy(new Error("archive validation aborted"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const value of stream) {
      if (signal.aborted) throw new Error("archive validation aborted");
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      actualSize += chunk.length;
      if (
        actualSize > entry.uncompressedSize
        || actualSize > ARCHIVE_VALIDATION_LIMITS.maxEntryUncompressedBytes
      ) {
        throw new Error("archive entry exceeded declared size");
      }
      calculatedCrc = crc32(chunk, calculatedCrc);
      mainXmlValidator?.write(chunk);
      if (capture) chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }

  if (actualSize !== entry.uncompressedSize || (calculatedCrc >>> 0) !== (entry.crc32 >>> 0)) {
    throw new Error("archive entry CRC or size mismatch");
  }
  mainXmlValidator?.finish();
  return capture ? Buffer.concat(chunks, actualSize) : null;
}

function parsePackageXml(value: Buffer): XmlElement[] | null {
  const text = value.toString("utf8");
  if (text.includes("\ufffd") || /<!DOCTYPE|<!ENTITY/iu.test(text)) return null;
  const elements: XmlElement[] = [];
  try {
    const parser = sax.parser(true, { xmlns: true, trim: false, normalize: false });
    parser.onerror = (error) => { throw error; };
    parser.ondoctype = () => { throw new Error("DOCTYPE is forbidden in package metadata"); };
    parser.onopentag = (node) => {
      const qualifiedNode = node as typeof node & { local: string; uri: string };
      if (elements.length >= ARCHIVE_VALIDATION_LIMITS.maxXmlElements) {
        throw new Error("package metadata has too many XML elements");
      }
      const rawAttributes = Object.values(node.attributes);
      if (rawAttributes.length > ARCHIVE_VALIDATION_LIMITS.maxXmlAttributesPerElement) {
        throw new Error("package metadata has too many XML attributes");
      }
      const attributes: Record<string, string> = {};
      for (const attribute of rawAttributes) {
        if (typeof attribute === "string") continue;
        const key = `${attribute.uri}\0${attribute.local}`;
        if (Object.prototype.hasOwnProperty.call(attributes, key)) {
          throw new Error("duplicate expanded XML attribute");
        }
        attributes[key] = attribute.value;
      }
      elements.push({
        localName: qualifiedNode.local,
        namespaceUri: qualifiedNode.uri,
        attributes,
      });
    };
    parser.write(text).close();
    return elements;
  } catch {
    return null;
  }
}

function hasElement(
  elements: readonly XmlElement[],
  localName: string,
  namespaceUri: string,
  attributes: Readonly<Record<string, string>>,
  attributeNamespaceUri = ""
): boolean {
  return elements.some((element) => (
    element.localName === localName
    && element.namespaceUri === namespaceUri
    && Object.entries(attributes).every(([name, value]) => (
      element.attributes[`${attributeNamespaceUri}\0${name}`] === value
    ))
  ));
}

function attributeValue(element: XmlElement, localName: string, namespaceUri = ""): string | undefined {
  return element.attributes[`${namespaceUri}\0${localName}`];
}

function hasExpectedRoot(elements: readonly XmlElement[], localName: string, namespaceUri: string): boolean {
  const root = elements[0];
  return Boolean(root && root.localName === localName && root.namespaceUri === namespaceUri);
}

function shouldCapturePackageEntry(extension: StructuralArchiveExtension, entryName: string): boolean {
  if (extension === ".zip") return false;
  if (extension === ".odt" || extension === ".ods") {
    return entryName === "mimetype" || entryName === "META-INF/manifest.xml";
  }
  return entryName === "[Content_Types].xml" || entryName === "_rels/.rels";
}

function expectedMainXml(
  extension: StructuralArchiveExtension,
  entryName: string
): MainXmlExpectation | null {
  if (extension === ".docx" || extension === ".xlsx" || extension === ".pptx") {
    const specification = OOXML_CONTENT_TYPES[extension];
    return entryName === specification.mainEntry ? {
      entryName,
      rootLocalName: specification.rootLocalName,
      rootNamespaceUris: specification.rootNamespaceUris,
    } : null;
  }
  if (extension === ".3mf" && entryName === "3D/3dmodel.model") {
    return {
      entryName,
      rootLocalName: "model",
      rootNamespaceUris: [
        "http://schemas.microsoft.com/3dmanufacturing/core/2015/02",
        "http://schemas.microsoft.com/3dmanufacturing/core/2013/01",
      ],
    };
  }
  if ((extension === ".odt" || extension === ".ods") && entryName === "content.xml") {
    return {
      entryName,
      rootLocalName: "document-content",
      rootNamespaceUris: ["urn:oasis:names:tc:opendocument:xmlns:office:1.0"],
    };
  }
  return null;
}

function validateOoxmlPackage(
  extension: ".docx" | ".xlsx" | ".pptx",
  entries: ReadonlyMap<string, ValidatedEntry>,
  captured: ReadonlyMap<string, Buffer>
): boolean {
  const specification = OOXML_CONTENT_TYPES[extension];
  const contentTypes = captured.get("[Content_Types].xml");
  const relationships = captured.get("_rels/.rels");
  const mainEntry = entries.get(specification.mainEntry);
  if (!contentTypes || !relationships || !mainEntry || mainEntry.isDirectory || mainEntry.uncompressedSize === 0) {
    return false;
  }

  const contentTypeElements = parsePackageXml(contentTypes);
  const relationshipElements = parsePackageXml(relationships);
  if (
    !contentTypeElements
    || !relationshipElements
    || !hasExpectedRoot(contentTypeElements, "Types", CONTENT_TYPES_NAMESPACE)
    || !hasExpectedRoot(relationshipElements, "Relationships", RELATIONSHIPS_NAMESPACE)
  ) return false;
  const hasContentType = hasElement(contentTypeElements, "Override", CONTENT_TYPES_NAMESPACE, {
    PartName: `/${specification.mainEntry}`,
    ContentType: specification.contentType,
  });
  const hasOfficeRelationship = relationshipElements.some((element) => (
    element.localName === "Relationship"
    && element.namespaceUri === RELATIONSHIPS_NAMESPACE
    && [
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
      "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
    ].includes(attributeValue(element, "Type") ?? "")
    && [specification.mainEntry, `/${specification.mainEntry}`].includes(attributeValue(element, "Target") ?? "")
  ));
  return hasContentType && hasOfficeRelationship;
}

function validateThreeMfPackage(
  entries: ReadonlyMap<string, ValidatedEntry>,
  captured: ReadonlyMap<string, Buffer>
): boolean {
  const modelPath = "3D/3dmodel.model";
  const model = entries.get(modelPath);
  const contentTypes = captured.get("[Content_Types].xml");
  const relationships = captured.get("_rels/.rels");
  if (!model || model.isDirectory || model.uncompressedSize === 0 || !contentTypes || !relationships) return false;
  const contentTypeElements = parsePackageXml(contentTypes);
  const relationshipElements = parsePackageXml(relationships);
  if (
    !contentTypeElements
    || !relationshipElements
    || !hasExpectedRoot(contentTypeElements, "Types", CONTENT_TYPES_NAMESPACE)
    || !hasExpectedRoot(relationshipElements, "Relationships", RELATIONSHIPS_NAMESPACE)
  ) return false;
  const modelContentType = "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";
  const hasContentType = (
    hasElement(contentTypeElements, "Override", CONTENT_TYPES_NAMESPACE, {
      PartName: `/${modelPath}`,
      ContentType: modelContentType,
    })
    || hasElement(contentTypeElements, "Default", CONTENT_TYPES_NAMESPACE, {
      Extension: "model",
      ContentType: modelContentType,
    })
  );
  const hasModelRelationship = relationshipElements.some((element) => (
    element.localName === "Relationship"
    && element.namespaceUri === RELATIONSHIPS_NAMESPACE
    && attributeValue(element, "Type") === "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"
    && [modelPath, `/${modelPath}`].includes(attributeValue(element, "Target") ?? "")
  ));
  return hasContentType && hasModelRelationship;
}

function validateOdfPackage(
  extension: ".odt" | ".ods",
  orderedEntries: readonly ValidatedEntry[],
  entries: ReadonlyMap<string, ValidatedEntry>,
  captured: ReadonlyMap<string, Buffer>
): boolean {
  const expectedMediaType = ODF_MEDIA_TYPES[extension];
  const firstEntry = orderedEntries[0];
  const mimetype = captured.get("mimetype");
  const manifest = captured.get("META-INF/manifest.xml");
  const content = entries.get("content.xml");
  if (
    !firstEntry
    || firstEntry.name !== "mimetype"
    || firstEntry.localHeaderOffset !== 0
    || firstEntry.compressionMethod !== 0
    || firstEntry.localExtraFieldLength !== 0
    || !mimetype
    || mimetype.toString("utf8") !== expectedMediaType
    || !manifest
    || !content
    || content.isDirectory
    || content.uncompressedSize === 0
  ) {
    return false;
  }
  const manifestElements = parsePackageXml(manifest);
  return Boolean(
    manifestElements
    && hasExpectedRoot(manifestElements, "manifest", ODF_MANIFEST_NAMESPACE)
    && hasElement(manifestElements, "file-entry", ODF_MANIFEST_NAMESPACE, {
      "full-path": "/",
      "media-type": expectedMediaType,
    }, ODF_MANIFEST_NAMESPACE)
  );
}

function validatePackageSemantics(
  extension: StructuralArchiveExtension,
  orderedEntries: readonly ValidatedEntry[],
  entries: ReadonlyMap<string, ValidatedEntry>,
  captured: ReadonlyMap<string, Buffer>
): boolean {
  if (extension === ".zip") return true;
  if (extension === ".3mf") return validateThreeMfPackage(entries, captured);
  if (extension === ".odt" || extension === ".ods") {
    return validateOdfPackage(extension, orderedEntries, entries, captured);
  }
  return validateOoxmlPackage(extension, entries, captured);
}

async function validateOpenArchive(
  extension: StructuralArchiveExtension,
  zipFile: ZipFile,
  eocd: EocdRecord,
  source: ArchiveValidationSource,
  signal: AbortSignal
): Promise<boolean> {
  const centralDirectoryCursor = (zipFile as unknown as { readEntryCursor: number }).readEntryCursor;
  if (
    zipFile.fileSize !== source.size
    || zipFile.entryCount !== eocd.entryCount
    || centralDirectoryCursor !== eocd.centralDirectoryOffset
  ) {
    return false;
  }

  const entries = new Map<string, ValidatedEntry>();
  const caseFoldedNames = new Set<string>();
  const orderedEntries: ValidatedEntry[] = [];
  const captured = new Map<string, Buffer>();
  const occupiedRanges: Array<Readonly<{ start: number; end: number }>> = [];
  let totalCompressed = 0;
  let totalUncompressed = 0;

  for await (const entry of zipFile.eachEntry()) {
    if (signal.aborted) throw new Error("archive validation aborted");
    const isDirectory = entry.fileName.endsWith("/");
    if (
      entries.size >= ARCHIVE_VALIDATION_LIMITS.maxEntries
      || entry.versionNeededToExtract > 20
      || entry.fileCommentLength > ARCHIVE_VALIDATION_LIMITS.maxEntryCommentBytes
      || !pathIsSafe(entry.fileName, entry.fileNameRaw.length)
      || !entryFlagsAreSupported(entry)
      || !entryTypeIsSafe(entry, isDirectory)
      || ![0, 8].includes(entry.compressionMethod)
      || !Number.isSafeInteger(entry.compressedSize)
      || !Number.isSafeInteger(entry.uncompressedSize)
      || entry.compressedSize < 0
      || entry.uncompressedSize < 0
      || entry.compressedSize > ARCHIVE_VALIDATION_LIMITS.maxEntryCompressedBytes
      || entry.uncompressedSize > ARCHIVE_VALIDATION_LIMITS.maxEntryUncompressedBytes
      || (entry.compressedSize === 0 && entry.uncompressedSize > 0)
      || entry.uncompressedSize > Math.max(1_024, entry.compressedSize * ARCHIVE_VALIDATION_LIMITS.maxCompressionRatio)
      || (entry.compressionMethod === 0 && entry.compressedSize !== entry.uncompressedSize)
      || (isDirectory && (entry.compressedSize !== 0 || entry.uncompressedSize !== 0 || entry.crc32 !== 0))
    ) {
      return false;
    }

    const foldedName = entry.fileName.toLowerCase();
    if (entries.has(entry.fileName) || caseFoldedNames.has(foldedName)) return false;
    caseFoldedNames.add(foldedName);

    totalCompressed += entry.compressedSize;
    totalUncompressed += entry.uncompressedSize;
    if (
      totalCompressed > ARCHIVE_VALIDATION_LIMITS.maxTotalCompressedBytes
      || totalUncompressed > ARCHIVE_VALIDATION_LIMITS.maxTotalUncompressedBytes
    ) {
      return false;
    }

    const localHeader = await zipFile.readLocalFileHeaderPromise(entry);
    if (!extraFieldsAreSupported(entry, localHeader) || !localHeaderMatchesCentralDirectory(entry, localHeader)) {
      return false;
    }
    const dataStart = entry.relativeOffsetOfLocalHeader + 30 + localHeader.fileNameLength + localHeader.extraFieldLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (
      !Number.isSafeInteger(entry.relativeOffsetOfLocalHeader)
      || entry.relativeOffsetOfLocalHeader < 0
      || dataStart < entry.relativeOffsetOfLocalHeader
      || dataEnd < dataStart
      || dataEnd > eocd.centralDirectoryOffset
    ) {
      return false;
    }
    let occupiedEnd = dataEnd;
    if ((entry.generalPurposeBitFlag & 0x0008) !== 0) {
      const remainingBeforeCentralDirectory = eocd.centralDirectoryOffset - dataEnd;
      if (remainingBeforeCentralDirectory < 12) return false;
      const descriptor = await readArchiveRange(source, dataEnd, Math.min(16, remainingBeforeCentralDirectory));
      const hasSignature = descriptor.length >= 16 && descriptor.readUInt32LE(0) === 0x08074b50;
      const valuesOffset = hasSignature ? 4 : 0;
      if (
        descriptor.length < valuesOffset + 12
        || descriptor.readUInt32LE(valuesOffset) !== entry.crc32
        || descriptor.readUInt32LE(valuesOffset + 4) !== entry.compressedSize
        || descriptor.readUInt32LE(valuesOffset + 8) !== entry.uncompressedSize
      ) {
        return false;
      }
      occupiedEnd += valuesOffset + 12;
    }
    occupiedRanges.push({ start: entry.relativeOffsetOfLocalHeader, end: occupiedEnd });

    const validated: ValidatedEntry = {
      name: entry.fileName,
      isDirectory,
      compressionMethod: entry.compressionMethod,
      uncompressedSize: entry.uncompressedSize,
      localHeaderOffset: entry.relativeOffsetOfLocalHeader,
      localExtraFieldLength: localHeader.extraFieldLength,
    };
    entries.set(entry.fileName, validated);
    orderedEntries.push(validated);
    if (!isDirectory) {
      const content = await readAndVerifyEntry(
        zipFile,
        entry,
        shouldCapturePackageEntry(extension, entry.fileName),
        expectedMainXml(extension, entry.fileName),
        signal
      );
      if (content) captured.set(entry.fileName, content);
    }
  }

  const finalDirectoryCursor = (zipFile as unknown as { readEntryCursor: number }).readEntryCursor;
  if (entries.size !== eocd.entryCount || finalDirectoryCursor !== eocd.offset) return false;
  occupiedRanges.sort((left, right) => left.start - right.start);
  if (occupiedRanges.length > 0 && occupiedRanges[0]!.start !== 0) return false;
  for (let index = 1; index < occupiedRanges.length; index += 1) {
    if (occupiedRanges[index]!.start < occupiedRanges[index - 1]!.end) return false;
  }
  return validatePackageSemantics(extension, orderedEntries, entries, captured);
}

export function isStructurallyValidatedArchiveExtension(extension: string): extension is StructuralArchiveExtension {
  return STRUCTURAL_ARCHIVE_EXTENSIONS.has(extension as StructuralArchiveExtension);
}

/**
 * Parse and stream-verify an archive without extracting it. The central and
 * local directories, every entry size and CRC, and package-specific manifests
 * must all agree inside the explicit resource bounds above.
 */
export async function archiveMatchesExtension(
  extension: StructuralArchiveExtension,
  source: ArchiveValidationSource,
  signal: AbortSignal
): Promise<boolean> {
  if (!archiveSourceIsValid(source) || signal.aborted) return false;
  let zipFile: ZipFile | null = null;
  try {
    const tail = await readArchiveTail(source);
    const eocd = parseBoundedEocd(tail, source.size);
    if (!eocd) return false;
    zipFile = source.buffer
      ? await fromBufferPromise(source.buffer, {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      })
      : await openPromise(source.path!, {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      });
    return await validateOpenArchive(extension, zipFile, eocd, source, signal);
  } catch {
    return false;
  } finally {
    zipFile?.close();
  }
}
