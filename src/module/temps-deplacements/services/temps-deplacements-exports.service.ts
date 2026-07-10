import { HttpError } from "../../../utils/httpError";
import {
  repoGetExportBatch,
  repoInsertExportBatch,
  repoListExportBatches,
  repoListWeeksForPeriod,
} from "../repository/temps-deplacements-exports.repository";
import { insertAuditLog, withTransaction, type AuditContext } from "../repository/temps-deplacements.repository";
import { isHrPrivileged, type Actor } from "./temps-deplacements-corrections.service";
import { buildPayrollCsv, buildPayrollPdf, sha256Hex, type PayrollWeekRow } from "./temps-deplacements-exports";

function assertPrivileged(actor: Actor): void {
  if (!isHrPrivileged(actor.role)) throw new HttpError(403, "HR_FORBIDDEN", "Export réservé aux responsables RH / direction.");
}

export interface ExportFile {
  filename: string;
  contentType: string;
  buffer: Buffer;
  checksum: string;
}

async function renderFile(format: "CSV" | "PDF", periodStart: string, periodEnd: string, rows: PayrollWeekRow[]): Promise<ExportFile> {
  if (format === "CSV") {
    const buffer = Buffer.from(buildPayrollCsv(rows), "utf-8");
    return { filename: `paie_${periodStart}_${periodEnd}.csv`, contentType: "text/csv; charset=utf-8", buffer, checksum: sha256Hex(buffer) };
  }
  const buffer = await buildPayrollPdf({ periodStart, periodEnd }, rows);
  return { filename: `paie_${periodStart}_${periodEnd}.pdf`, contentType: "application/pdf", buffer, checksum: sha256Hex(buffer) };
}

// Crée un lot d'export FIGÉ : octets gelés (base64) + checksum SHA-256 en base → re-téléchargement identique.
export async function createExport(
  actor: Actor,
  input: { period_start: string; period_end: string; format: "CSV" | "PDF" },
  audit: AuditContext
) {
  assertPrivileged(actor);
  if (input.period_end < input.period_start) throw new HttpError(400, "HR_EXPORT_BAD_PERIOD", "Période invalide (fin < début).");

  const rows = await repoListWeeksForPeriod(input.period_start, input.period_end);
  const file = await renderFile(input.format, input.period_start, input.period_end, rows);

  const frozen = {
    row_count: rows.length,
    rows, // conservé pour transparence/audit (recalculable)
    file_base64: file.buffer.toString("base64"),
    filename: file.filename,
    content_type: file.contentType,
    generated_meta: { period_start: input.period_start, period_end: input.period_end, format: input.format },
  };

  const batch = await withTransaction(async (client) => {
    const row = await repoInsertExportBatch(client, {
      period_start: input.period_start,
      period_end: input.period_end,
      exported_by: actor.id,
      format: input.format,
      frozen_snapshot_json: frozen,
      checksum: file.checksum,
    });
    await insertAuditLog(client, audit, {
      action: "temps-deplacements.export.create",
      entity_type: "hr_payroll_export_batches",
      entity_id: row.id,
      details: { format: input.format, period_start: input.period_start, period_end: input.period_end, row_count: rows.length, checksum: file.checksum },
    });
    return row;
  });

  return { ...batch, row_count: rows.length };
}

export async function listExports(actor: Actor) {
  assertPrivileged(actor);
  return repoListExportBatches();
}

// Renvoie les octets figés + VÉRIFIE l'intégrité (checksum stocké == checksum recalculé sur les octets).
export async function getExportFile(actor: Actor, id: string): Promise<ExportFile> {
  assertPrivileged(actor);
  const batch = await repoGetExportBatch(id);
  if (!batch) throw new HttpError(404, "HR_EXPORT_NOT_FOUND", "Lot d'export introuvable.");
  const frozen = (batch.frozen_snapshot_json ?? {}) as { file_base64?: string; filename?: string; content_type?: string };
  if (!frozen.file_base64) throw new HttpError(409, "HR_EXPORT_NO_FILE", "Lot sans fichier figé.");
  const buffer = Buffer.from(frozen.file_base64, "base64");
  const recomputed = sha256Hex(buffer);
  if (recomputed !== batch.checksum) throw new HttpError(409, "HR_EXPORT_CHECKSUM_MISMATCH", "Intégrité de l'export compromise.");
  return {
    filename: frozen.filename ?? `export_${id}`,
    contentType: frozen.content_type ?? "application/octet-stream",
    buffer,
    checksum: batch.checksum,
  };
}
