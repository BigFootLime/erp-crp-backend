import { renderCerpDocument, type CerpLineRow } from "../pdf/cerp-document";
import { issuerIdentityLine, issuerLegalMentions } from "../pdf/legal-mentions";
import type { AuthoritativePdfArchiveRecord } from "./authoritative-document.types";
import type { InternalCreationSnapshot } from "./internal-creation-snapshot";

export type { InternalCreationSnapshot } from "./internal-creation-snapshot";

const clean = (value: unknown, max = 2_000): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const invalidSnapshot = (): never => { throw new Error("INTERNAL_CREATION_SNAPSHOT_INVALID"); };

/** Strictly accepts the small, server-composed snapshot grammar; no browser payload is rendered. */
export function parseInternalCreationSnapshot(archive: AuthoritativePdfArchiveRecord): InternalCreationSnapshot {
  if (!isPlainRecord(archive.sourceSnapshot)) invalidSnapshot();
  const source = archive.sourceSnapshot as Partial<InternalCreationSnapshot>;
  const summary = source.summary;
  const sections = source.sections;
  if (source.type !== "INTERNAL_CREATION_SNAPSHOT" || !clean(source.entity_label, 120) || !clean(source.reference, 160) || !isPlainRecord(source.issuer)) invalidSnapshot();
  if (!Array.isArray(summary) || !Array.isArray(sections)) {
    throw new Error("INTERNAL_CREATION_SNAPSHOT_INVALID");
  }
  if (summary.length > 12 || sections.length > 24) invalidSnapshot();
  for (const item of summary) {
    if (!isPlainRecord(item) || !clean(item.label, 80) || (item.value !== null && !clean(item.value, 500))) invalidSnapshot();
  }
  for (const section of sections) {
    if (!isPlainRecord(section) || !clean(section.title, 120) || (!section.rows && !section.table && !section.notes)) invalidSnapshot();
    if (section.rows) {
      if (!Array.isArray(section.rows) || section.rows.length > 80) invalidSnapshot();
      for (const row of section.rows) {
        if (!isPlainRecord(row) || !clean(row.label, 100) || (row.value !== null && !clean(row.value, 1_000))) invalidSnapshot();
      }
    }
    if (section.table) {
      if (!isPlainRecord(section.table) || !Array.isArray(section.table.columns) || !Array.isArray(section.table.rows) || section.table.columns.length === 0 || section.table.columns.length > 8 || section.table.rows.length > 250) invalidSnapshot();
      const keys = new Set<string>();
      for (const column of section.table.columns) {
        if (!isPlainRecord(column)) throw new Error("INTERNAL_CREATION_SNAPSHOT_INVALID");
        const key = column.key;
        if (typeof key !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(key) || !clean(column.label, 80) || keys.has(key)) {
          throw new Error("INTERNAL_CREATION_SNAPSHOT_INVALID");
        }
        keys.add(key);
      }
      for (const row of section.table.rows) {
        if (!isPlainRecord(row)) invalidSnapshot();
        const rowKeys = Object.keys(row);
        if (rowKeys.length !== keys.size || rowKeys.some((key) => !keys.has(key))) invalidSnapshot();
        for (const key of keys) {
          const value = row[key];
          if (value !== null && !clean(value, 1_000)) invalidSnapshot();
        }
      }
    }
    if (section.notes !== undefined && section.notes !== null && !clean(section.notes, 20_000)) invalidSnapshot();
  }
  return source as InternalCreationSnapshot;
}

export async function renderInternalCreationSnapshotPdf({ archive }: { archive: AuthoritativePdfArchiveRecord }): Promise<Buffer> {
  const source = parseInternalCreationSnapshot(archive);
  const createdAt = new Date(archive.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error("INTERNAL_CREATION_SNAPSHOT_CREATED_AT_INVALID");
  return renderCerpDocument({
    documentType: "Instantané interne", name: source.reference, code: source.reference,
    subtitle: `Création archivée le ${createdAt.toLocaleDateString("fr-FR")}`,
    status: "BROUILLON", monogramName: source.entity_label, generatedAt: createdAt.toLocaleDateString("fr-FR"),
    flag: "INTERNE / BROUILLON", watermark: "INTERNE / BROUILLON",
    footerNote: `Instantané interne GED — non opposable — SHA-256 ${archive.snapshotSha256.slice(0, 16)}…`,
    legalIdentity: issuerIdentityLine(source.issuer) ?? "Croix Rousse Precision",
    legalMentions: issuerLegalMentions(source.issuer),
    title: `${source.entity_label} — ${source.reference}`, subject: "INTERNE / BROUILLON — instantané de création non opposable", creationDate: createdAt,
  }, (ctx) => {
    ctx.legalStrip([...source.summary]);
    for (const section of source.sections) {
      ctx.section(section.title);
      if (section.rows?.length) {
        const top = ctx.y;
        let bottom = top;
        const columns = Math.min(3, Math.max(1, section.rows.length));
        section.rows.forEach((row, index) => { bottom = Math.max(bottom, ctx.field(row.label, row.value, 38 + (index % columns) * (520 / columns), 500 / columns)); });
        ctx.y = bottom + 8;
      }
      if (section.table) {
        const columns = section.table.columns.map((column) => ({ key: column.key, label: column.label, flex: 1 }));
        const rows: CerpLineRow[] = section.table.rows.map((row) => ({ cells: Object.fromEntries(section.table!.columns.map((column) => [column.key, row[column.key] ?? "—"])) }));
        ctx.linesTable({ columns, rows, emptyLabel: "Aucune donnée." });
      }
      if (section.notes) ctx.notes(section.notes);
    }
  });
}
