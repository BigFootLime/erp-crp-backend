import type { LegalParty } from "../pdf/legal-mentions";

export type InternalCreationSnapshot = Readonly<{
  type: "INTERNAL_CREATION_SNAPSHOT";
  entity_label: string;
  reference: string;
  issuer: LegalParty;
  entity_image?: Readonly<{ ged_version_id: string }>;
  summary: ReadonlyArray<{ label: string; value: string | null }>;
  sections: ReadonlyArray<{
    title: string;
    rows?: ReadonlyArray<{ label: string; value: string | null }>;
    table?: { columns: ReadonlyArray<{ key: string; label: string }>; rows: ReadonlyArray<Record<string, string | null>> };
    notes?: string | null;
  }>;
}>;

const text = (value: unknown, max: number): string | null => {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result ? result.slice(0, max) : null;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Builds the only generic creation-snapshot grammar accepted by the renderer.
 * Callers pass server-read values; this helper deliberately has no request DTO.
 */
export function buildInternalCreationSnapshot(input: {
  entityLabel: string; reference: string; issuer?: LegalParty;
  entityImageVersionId?: string | null;
  summary?: ReadonlyArray<{ label: string; value: unknown }>;
  sections?: ReadonlyArray<{
    title: string; rows?: ReadonlyArray<{ label: string; value: unknown }>;
    table?: { columns: ReadonlyArray<{ key: string; label: string }>; rows: ReadonlyArray<Record<string, unknown>> };
    notes?: unknown;
  }>;
}): InternalCreationSnapshot {
  const entity_label = text(input.entityLabel, 120);
  const reference = text(input.reference, 160);
  if (!entity_label || !reference) throw new Error("INTERNAL_CREATION_SNAPSHOT_INPUT_INVALID");
  const entityImageVersionId = text(input.entityImageVersionId, 36);
  if (entityImageVersionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entityImageVersionId)) {
    throw new Error("INTERNAL_CREATION_SNAPSHOT_IMAGE_INVALID");
  }
  const summary = (input.summary ?? []).slice(0, 12).flatMap((item) => {
    const label = text(item.label, 80); return label ? [{ label, value: text(item.value, 500) }] : [];
  });
  const sections = (input.sections ?? []).slice(0, 24).flatMap((section) => {
    const title = text(section.title, 120); if (!title) return [];
    const rows = section.rows?.slice(0, 80).flatMap((row) => { const label = text(row.label, 100); return label ? [{ label, value: text(row.value, 1_000) }] : []; });
    const seenColumnKeys = new Set<string>();
    const columns = section.table?.columns.slice(0, 8).flatMap((column) => {
      const key = text(column.key, 32) ?? "";
      const label = text(column.label, 80) ?? "";
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(key) || !label || seenColumnKeys.has(key)) return [];
      seenColumnKeys.add(key);
      return [{ key, label }];
    }) ?? [];
    const table = section.table && columns.length > 0
      ? {
          columns,
          // Persist only declared cells. This keeps malformed runtime input and
          // accidental extra object keys out of the immutable archive grammar.
          rows: section.table.rows.slice(0, 250).map((row) => {
            const source = isPlainRecord(row) ? row : {};
            return Object.fromEntries(columns.map((column) => [column.key, text(source[column.key], 1_000)]));
          }),
        }
      : undefined;
    const notes = text(section.notes, 20_000);
    return rows?.length || table || notes ? [{ title, ...(rows?.length ? { rows } : {}), ...(table ? { table } : {}), ...(notes ? { notes } : {}) }] : [];
  });
  return {
    type: "INTERNAL_CREATION_SNAPSHOT",
    entity_label,
    reference,
    issuer: input.issuer ?? { legal_name: "Croix Rousse Precision" },
    ...(entityImageVersionId ? { entity_image: { ged_version_id: entityImageVersionId } } : {}),
    summary,
    sections,
  };
}
