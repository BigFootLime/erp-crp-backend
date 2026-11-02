import { parseTabularFile } from "../import-assistant/domain/tabular-file-parser";
import { HttpError } from "../../utils/httpError";
import type {
  CanonicalDemandImportRow,
  DemandImportCompositeKey,
  DemandImportDiagnostic,
  DemandImportFileInput,
  DemandImportInput,
  DemandImportPreviewRow,
  DemandImportRawRow,
  DemandImportResult,
  DemandImportSource,
} from "./types";

export * from "./types";

const MAX_ROWS = 100_000;
export const MAX_DEMAND_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_LENGTH = 500;
const MAX_COMMENT_LENGTH = 2_000;
const VISION_NEED_DATE_SENTINELS = new Set(["31/12/9000", "9000-12-31"]);

type Candidate = Partial<CanonicalDemandImportRow>;

function value(
  record: DemandImportRawRow,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const raw = record[name];
    if (raw === null || raw === undefined) continue;
    const normalized = String(raw).trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizeDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const french = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(raw);
  const value = iso
    ? raw
    : french
      ? `${french[3]}-${french[2].padStart(2, "0")}-${french[1].padStart(2, "0")}`
      : undefined;
  if (!value) return undefined;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return value < "1900-01-01" ||
    value >= "2200-01-01" ||
    Number.isNaN(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

function normalizeInstant(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      raw,
    )
  )
    return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function normalizeQuantity(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const decimal = raw.replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,3})?$/.test(decimal)) return undefined;
  const parsed = Number(decimal);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function kindFromVision(
  raw: string | undefined,
): "FIRM" | "FORECAST" | undefined {
  const normalized = raw?.trim().toLocaleLowerCase("fr-FR");
  if (
    ["ferme", "firm", "en commande ferme", "cde fermee"].includes(
      normalized ?? "",
    )
  )
    return "FIRM";
  if (
    ["forecast", "prv", "prévision", "prochaines prévisions"].includes(
      normalized ?? "",
    )
  )
    return "FORECAST";
  // "Cde ouverte" describes the framework, not the firmness of an individual schedule.
  return undefined;
}

function genericCandidate(row: DemandImportRawRow): Candidate {
  const kind = value(row, "kind", "demand_kind", "TYPE_CDE");
  return {
    external_site: value(row, "external_site", "site"),
    external_order_key: value(
      row,
      "external_order_key",
      "order_key",
      "NUM_CDE",
    ),
    external_line_key: value(
      row,
      "external_line_key",
      "line_key",
      "line_number",
    ),
    external_schedule_key: value(
      row,
      "external_schedule_key",
      "schedule_key",
      "schedule_number",
    ),
    source_version: value(row, "source_version", "version"),
    source_as_of: normalizeInstant(
      value(row, "source_as_of", "as_of", "exported_at"),
    ),
    kind: kind === "FIRM" || kind === "FORECAST" ? kind : undefined,
    quantity: normalizeQuantity(
      value(row, "quantity", "quantite", "qte", "QUANTITE", "Quantité"),
    ),
    unit: value(row, "unit", "unite", "UNITE", "Unité")?.toUpperCase(),
    quantity_basis: (value(
      row,
      "quantity_basis",
      "BASE_QUANTITE",
    )?.toUpperCase() ?? "TOTAL") as Candidate["quantity_basis"],
    need_date: normalizeDate(
      value(row, "need_date", "date_besoin", "DATE_BESOIN"),
    ),
    customer_order_date: normalizeDate(
      value(row, "customer_order_date", "DATE_CDE"),
    ),
    source_requested_date: normalizeDate(
      value(row, "source_requested_date", "DATE_DEMANDEE"),
    ),
    source_confirmed_date: normalizeDate(
      value(row, "source_confirmed_date", "DATE_CONF"),
    ),
    article_code: value(row, "article_code", "article", "ARTICLE"),
    customer_reference: value(row, "customer_reference", "customer_ref"),
    contract_reference: value(row, "contract_reference", "contract_ref"),
    comment: value(row, "comment", "commentaire"),
  };
}

function visionCandidate(row: DemandImportRawRow): Candidate {
  const rawNeedDate = value(row, "DATE_BESOIN", "need_date");
  const base = genericCandidate(row);
  const remaining = value(row, "QTE_SOLDE");
  return {
    ...base,
    external_site: value(row, "external_site", "SITE"),
    external_order_key: value(row, "NUM_CDE", "Cde Order", "external_order_key"),
    external_line_key: value(row, "ID_LIGNE", "NUM_LIGNE", "external_line_key"),
    external_schedule_key: value(row, "ID_ECHEANCE", "external_schedule_key"),
    kind: kindFromVision(value(row, "FERMETE", "kind", "TYPE_CDE")),
    quantity: remaining !== undefined ? normalizeQuantity(remaining) : base.quantity,
    quantity_basis: remaining !== undefined ? "REMAINING" : base.quantity_basis,
    unit: base.unit ?? value(row, "UA")?.toUpperCase(),
    need_date: VISION_NEED_DATE_SENTINELS.has(rawNeedDate ?? "")
      ? undefined
      : normalizeDate(rawNeedDate),
    article_code: value(row, "ARTICLE", "article_code"),
    customer_reference: value(row, "NUM_CDE", "Cde Order", "customer_reference"),
    contract_reference: value(row, "CONTRAT", "contract_reference"),
  };
}

/** One row per printed schedule, after local transcription or native ERP export.
 * The two PRV column groups are separate schedules. Pack size, cumulative counts and
 * overdue subtotals are page metadata; none are quantities to order. */
function programmeCandidate(row: DemandImportRawRow): Candidate {
  const date = value(
    row,
    "DATE_ECHEANCE",
    "Date échéance",
    "Date",
    "need_date",
  );
  return {
    ...genericCandidate(row),
    external_site: value(row, "SITE", "external_site"),
    external_order_key: value(row, "NUM_CDE", "external_order_key"),
    external_line_key: value(row, "ID_LIGNE", "external_line_key"),
    external_schedule_key: value(row, "ID_ECHEANCE", "external_schedule_key"),
    article_code: value(row, "ARTICLE", "Article", "article_code"),
    contract_reference: value(row, "CONTRAT", "Contrat", "contract_reference"),
    kind: kindFromVision(value(row, "RUBRIQUE", "Rubrique", "Type", "kind")),
    quantity_basis: "REMAINING",
    quantity: normalizeQuantity(
      value(row, "QUANTITE_ECHEANCE", "Quantité", "quantity"),
    ),
    unit: value(row, "UNITE", "Unité", "unit")?.toUpperCase(),
    need_date: normalizeDate(date),
  };
}
function sourceCandidate(
  source: DemandImportSource,
  row: DemandImportRawRow,
): Candidate {
  if (source === "VISION_PROGRAMME") return programmeCandidate(row);
  return source === "VISION_SYSTEMS"
    ? visionCandidate(row)
    : genericCandidate(row);
}

function issue(
  code: string,
  message: string,
  field: string | null,
  rowNumber: number,
): DemandImportDiagnostic {
  return { level: "ERROR", code, message, field, row_number: rowNumber };
}

function bounded(
  candidate: Candidate,
  rowNumber: number,
): DemandImportDiagnostic[] {
  const diagnostics: DemandImportDiagnostic[] = [];
  for (const field of [
    "external_site",
    "external_order_key",
    "external_line_key",
    "external_schedule_key",
    "source_version",
    "article_code",
    "customer_reference",
    "contract_reference",
  ] as const) {
    if (candidate[field] && candidate[field].length > MAX_TEXT_LENGTH)
      diagnostics.push(
        issue(
          "VALUE_TOO_LONG",
          `La valeur ${field} dépasse ${MAX_TEXT_LENGTH} caractères.`,
          field,
          rowNumber,
        ),
      );
  }
  if (candidate.comment && candidate.comment.length > MAX_COMMENT_LENGTH)
    diagnostics.push(
      issue(
        "VALUE_TOO_LONG",
        `Le commentaire dépasse ${MAX_COMMENT_LENGTH} caractères.`,
        "comment",
        rowNumber,
      ),
    );
  return diagnostics;
}

function validateCandidate(
  source: DemandImportSource,
  raw: DemandImportRawRow,
  candidate: Candidate,
  rowNumber: number,
): DemandImportDiagnostic[] {
  const diagnostics = bounded(candidate, rowNumber);
  const review = value(raw, "REVIEW_REQUIRED", "REVUE_REQUISE");
  if (review && !["FALSE", "NON", "0"].includes(review.toUpperCase()))
    diagnostics.push(
      issue(
        "SOURCE_REVIEW_REQUIRED",
        "Contrôler la transcription sur la page source avant d’importer cette échéance.",
        "REVIEW_REQUIRED",
        rowNumber,
      ),
    );
  if (
    candidate.quantity_basis !== "TOTAL" &&
    candidate.quantity_basis !== "REMAINING"
  )
    diagnostics.push(
      issue(
        "BASIS_INVALID",
        "Précisez si la quantité est totale ou restante.",
        "quantity_basis",
        rowNumber,
      ),
    );
  if (source === "VISION_PROGRAMME" && !candidate.contract_reference)
    diagnostics.push(
      issue(
        "CONTRACT_REQUIRED",
        "Contrat du bloc article manquant.",
        "contract_reference",
        rowNumber,
      ),
    );
  if (
    source === "VISION_SYSTEMS" &&
    !candidate.kind &&
    value(raw, "TYPE_CDE")?.toLowerCase() === "cde ouverte"
  )
    diagnostics.push(
      issue(
        "FIRMNESS_REQUIRED",
        "Une commande ouverte peut contenir du ferme et du prévisionnel. Qualifiez l’échéance.",
        "kind",
        rowNumber,
      ),
    );
  const required = [
    "external_site",
    "external_order_key",
    "external_line_key",
    "external_schedule_key",
    "source_version",
    "source_as_of",
    "kind",
    "quantity",
    "unit",
    "article_code",
    "need_date",
  ] as const;
  for (const field of required)
    if (candidate[field] === undefined)
      diagnostics.push(
        issue(
          "REQUIRED_FIELD_MISSING",
          `Champ requis absent : ${field}.`,
          field,
          rowNumber,
        ),
      );
  if (
    source === "VISION_SYSTEMS" &&
    VISION_NEED_DATE_SENTINELS.has(value(raw, "DATE_BESOIN") ?? "")
  ) {
    diagnostics.push(
      issue(
        "SENTINEL_DATE_REQUIRES_REVIEW",
        "DATE_BESOIN contient une valeur sentinelle non planifiable.",
        "need_date",
        rowNumber,
      ),
    );
  }
  if (
    source === "GENERIC" &&
    value(raw, "kind", "demand_kind", "TYPE_CDE") &&
    !candidate.kind
  ) {
    diagnostics.push(
      issue(
        "DEMAND_KIND_INVALID",
        "Le type doit être FIRM ou FORECAST.",
        "kind",
        rowNumber,
      ),
    );
  }
  if (
    value(raw, "need_date", "date_besoin", "DATE_BESOIN") &&
    !candidate.need_date &&
    !VISION_NEED_DATE_SENTINELS.has(value(raw, "DATE_BESOIN") ?? "")
  ) {
    diagnostics.push(
      issue(
        "DATE_INVALID",
        "La date de besoin est invalide.",
        "need_date",
        rowNumber,
      ),
    );
  }
  if (
    value(raw, "source_as_of", "as_of", "exported_at") &&
    !candidate.source_as_of
  ) {
    diagnostics.push(
      issue(
        "SOURCE_AS_OF_INVALID",
        "La date d’extraction doit être une date ISO valide.",
        "source_as_of",
        rowNumber,
      ),
    );
  }
  if (
    value(raw, "quantity", "quantite", "qte") &&
    candidate.quantity === undefined
  )
    diagnostics.push(
      issue(
        "QUANTITY_INVALID",
        "La quantité doit être un nombre fini.",
        "quantity",
        rowNumber,
      ),
    );
  if (
    candidate.quantity !== undefined &&
    (candidate.quantity <= 0 || candidate.quantity > 1_000_000_000)
  ) {
    diagnostics.push(
      issue(
        "QUANTITY_OUT_OF_RANGE",
        "La quantité doit être strictement positive et bornée.",
        "quantity",
        rowNumber,
      ),
    );
  }
  return diagnostics;
}

function isCanonical(
  candidate: Candidate,
): candidate is CanonicalDemandImportRow {
  return (
    candidate.external_site !== undefined &&
    candidate.external_order_key !== undefined &&
    candidate.external_line_key !== undefined &&
    candidate.external_schedule_key !== undefined &&
    candidate.source_version !== undefined &&
    candidate.source_as_of !== undefined &&
    candidate.kind !== undefined &&
    candidate.unit !== undefined &&
    candidate.quantity !== undefined &&
    candidate.need_date !== undefined
  );
}

export function demandImportCompositeKey(
  row: DemandImportCompositeKey,
): string {
  return [
    row.external_site,
    row.external_order_key,
    row.external_line_key,
    row.external_schedule_key,
  ]
    .map((part) => `${part.length}:${part}`)
    .join("|");
}

/** Stable chronology: extraction timestamp first, opaque source version only as deterministic tie-breaker. */
export function compareDemandImportEpoch(
  left: Pick<CanonicalDemandImportRow, "source_as_of" | "source_version">,
  right: Pick<CanonicalDemandImportRow, "source_as_of" | "source_version">,
): number {
  const byInstant =
    left.source_as_of < right.source_as_of
      ? -1
      : left.source_as_of > right.source_as_of
        ? 1
        : 0;
  if (byInstant !== 0) return byInstant;
  return left.source_version < right.source_version
    ? -1
    : left.source_version > right.source_version
      ? 1
      : 0;
}

export function parseDemandImport(
  input: DemandImportInput,
): DemandImportResult {
  if (input.rows.length > MAX_ROWS)
    throw new HttpError(
      413,
      "DEMAND_IMPORT_TOO_MANY_ROWS",
      `L’import dépasse ${MAX_ROWS} lignes.`,
    );
  const first = input.first_data_row_number ?? 2;
  const preview_rows: DemandImportPreviewRow[] = [];
  const rows: CanonicalDemandImportRow[] = [];
  const diagnostics: DemandImportDiagnostic[] = [];
  const validKeys = new Map<string, DemandImportPreviewRow>();

  input.rows.forEach((raw, index) => {
    const row_number = first + index;
    // Metadata selected for an import is a default only: an explicit value in
    // the file remains visible and is subsequently rejected by the one-scope
    // persistence gate if it disagrees with the rest of the batch.
    const mapped = sourceCandidate(input.source, raw);
    const candidate = {
      ...mapped,
      external_site: mapped.external_site ?? input.defaults?.external_site,
      source_version: mapped.source_version ?? input.defaults?.source_version,
      source_as_of:
        mapped.source_as_of ??
        (value(raw, "source_as_of", "as_of", "exported_at")
          ? undefined
          : normalizeInstant(input.defaults?.source_as_of)),
    };
    const rowDiagnostics = validateCandidate(
      input.source,
      raw,
      candidate,
      row_number,
    );
    const preview: DemandImportPreviewRow = {
      row_number,
      candidate,
      diagnostics: rowDiagnostics,
    };
    preview_rows.push(preview);
    diagnostics.push(...rowDiagnostics);
    if (!isCanonical(candidate) || rowDiagnostics.length > 0) return;
    const key = demandImportCompositeKey(candidate);
    const original = validKeys.get(key);
    if (original) {
      const duplicate = issue(
        "DUPLICATE_COMPOSITE_KEY",
        "La clé site/commande/ligne/échéance est dupliquée dans le même import.",
        null,
        row_number,
      );
      const originalDuplicate = issue(
        "DUPLICATE_COMPOSITE_KEY",
        "La clé site/commande/ligne/échéance est dupliquée dans le même import.",
        null,
        original.row_number,
      );
      preview.diagnostics.push(duplicate);
      original.diagnostics.push(originalDuplicate);
      diagnostics.push(duplicate, originalDuplicate);
      return;
    }
    validKeys.set(key, preview);
    rows.push(candidate);
  });

  const invalid = preview_rows.filter((row) =>
    row.diagnostics.some((diagnostic) => diagnostic.level === "ERROR"),
  ).length;
  const duplicateRows = preview_rows.filter((row) =>
    row.diagnostics.some(
      (diagnostic) => diagnostic.code === "DUPLICATE_COMPOSITE_KEY",
    ),
  ).length;
  if (input.source === "VISION_SYSTEMS" && invalid > 0) {
    diagnostics.push({
      level: "WARNING",
      code: "VISION_SYSTEMS_ENRICHMENT_REQUIRED",
      field: null,
      count: invalid,
      message:
        "Le format Vision Systems doit fournir les clés ligne/échéance, la quantité, le site et les métadonnées de version avant application.",
    });
  }
  const applicable = rows.filter(
    (row) => !validKeys.get(demandImportCompositeKey(row))?.diagnostics.length,
  );
  return {
    rows: applicable,
    preview_rows,
    diagnostics,
    summary: {
      total: input.rows.length,
      valid: applicable.length,
      invalid,
      duplicate_composite_keys: duplicateRows,
    },
  };
}

/** Parses only CSV/XLSX via the hardened shared parser, then applies the source-specific mapping. */
export function parseDemandImportFile(
  input: DemandImportFileInput,
): DemandImportResult {
  if (
    input.file.size > MAX_DEMAND_IMPORT_FILE_BYTES ||
    input.file.buffer.length > MAX_DEMAND_IMPORT_FILE_BYTES
  ) {
    throw new HttpError(
      413,
      "DEMAND_IMPORT_FILE_TOO_LARGE",
      "Le fichier de demande dépasse 10 Mo.",
    );
  }
  const parsed = parseTabularFile(input.file);
  const sheet = input.sheet_name
    ? parsed.sheets.find((candidate) => candidate.name === input.sheet_name)
    : parsed.sheets.find((candidate) => candidate.rows.length > 0);
  if (!sheet)
    throw new HttpError(
      400,
      "DEMAND_IMPORT_SHEET_NOT_FOUND",
      "La feuille demandée est introuvable ou vide.",
    );
  return parseDemandImport({
    source: input.source,
    rows: sheet.rows,
    defaults: input.defaults,
    first_data_row_number: 2,
  });
}
