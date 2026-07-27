import crypto from "node:crypto";

import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { HttpError } from "../../../utils/httpError";
import { getImportCapability, IMPORT_CAPABILITIES } from "../domain/import-capabilities";
import { importRowDedupeKeys, normalizeImportRow, validateMapping } from "../domain/import-normalization";
import { parseTabularFile } from "../domain/tabular-file-parser";
import * as repo from "../repository/import-assistant.repository";
import type {
  ImportAuditContext,
  ImportBatchRow,
  ImportBatchSummary,
  ImportEntityType,
  ImportIssue,
  ImportMapping,
} from "../types/import-assistant.types";
import { createImportTarget, importRowIdempotencyKey } from "./import-targets.service";

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeError(error: unknown): ImportIssue {
  if (error instanceof HttpError) {
    return { code: error.code, message: error.message, field: null };
  }
  if (error instanceof Error) {
    return { code: "IMPORT_ROW_FAILED", message: error.message.slice(0, 500), field: null };
  }
  return { code: "IMPORT_ROW_FAILED", message: "Erreur inconnue pendant l’import.", field: null };
}

async function auditBatch(
  audit: ImportAuditContext,
  action: string,
  batchId: string,
  details: Record<string, unknown>
) {
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body: {
      event_type: "ACTION",
      action,
      page_key: "import-assistant",
      entity_type: "DATA_IMPORT_BATCH",
      entity_id: batchId,
      path: audit.path ?? "/api/v1/import-assistant",
      client_session_id: audit.client_session_id,
      details,
    },
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
  });
}

export function listImportCapabilities() {
  return IMPORT_CAPABILITIES;
}

export async function createImportBatch(params: {
  entity_type: ImportEntityType;
  source_system: string;
  sheet_name?: string;
  file: Express.Multer.File;
  audit: ImportAuditContext;
}): Promise<{ batch: ImportBatchRow; reused: boolean; available_sheets: Array<{ name: string; rows: number }> }> {
  await repo.repoPurgeExpiredStaging();
  const capability = getImportCapability(params.entity_type);
  if (!capability) throw new HttpError(400, "IMPORT_ENTITY_UNKNOWN", "Domaine d’import inconnu.");
  if (!capability.confirm_enabled) {
    throw new HttpError(409, "IMPORT_DOMAIN_GATED", capability.unavailable_reason ?? "Ce domaine est encore bloqué.");
  }

  const parsed = parseTabularFile(params.file);
  const availableSheets = parsed.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.length }));
  const selected = params.sheet_name
    ? parsed.sheets.find((sheet) => sheet.name === params.sheet_name)
    : parsed.sheets.find((sheet) => sheet.rows.length > 0) ?? parsed.sheets[0];
  if (!selected) throw new HttpError(400, "IMPORT_SHEET_NOT_FOUND", "La feuille demandée n’existe pas dans le classeur.");
  if (selected.rows.length === 0) throw new HttpError(400, "IMPORT_SHEET_EMPTY", "La feuille sélectionnée ne contient aucune ligne de données.");

  const sourceHash = sha256(params.file.buffer);
  const existing = await repo.repoFindBatchBySource({
    source_system: params.source_system,
    entity_type: params.entity_type,
    source_sha256: sourceHash,
    sheet_name: selected.name,
  });
  if (existing) return { batch: existing, reused: true, available_sheets: availableSheets };

  const batch = await repo.repoCreateBatch({
    source_system: params.source_system,
    entity_type: params.entity_type,
    source_name: params.file.originalname,
    source_sha256: sourceHash,
    source_size: params.file.size,
    source_mime: params.file.mimetype || null,
    sheet_name: selected.name,
    headers: selected.headers,
    rows: selected.rows,
    created_by: params.audit.user_id,
  });
  await auditBatch(params.audit, "data-import.batch.create", batch.id, {
    entity_type: batch.entity_type,
    source_sha256: batch.source_sha256,
    source_size: batch.source_size,
    rows: batch.summary.total,
    sheet_name: batch.sheet_name,
  });
  return { batch, reused: false, available_sheets: availableSheets };
}

export async function getImportBatch(id: string) {
  const batch = await repo.repoGetBatch(id);
  if (!batch) throw new HttpError(404, "IMPORT_BATCH_NOT_FOUND", "Lot d’import introuvable.");
  const capability = getImportCapability(batch.entity_type);
  const approved = new Set(batch.mapping?.approved_decisions ?? []);
  return {
    ...batch,
    missing_decisions: (capability?.decisions ?? []).filter((decision) => !approved.has(decision.id)),
  };
}

export async function listImportBatches(params: Parameters<typeof repo.repoListBatches>[0]) {
  await repo.repoPurgeExpiredStaging();
  return repo.repoListBatches(params);
}

export function listImportRows(params: Parameters<typeof repo.repoListBatchRows>[0]) {
  return repo.repoListBatchRows(params);
}

export async function previewImportBatch(params: {
  id: string;
  mapping: ImportMapping;
  audit: ImportAuditContext;
}) {
  const batch = await repo.repoGetBatch(params.id);
  if (!batch) throw new HttpError(404, "IMPORT_BATCH_NOT_FOUND", "Lot d’import introuvable.");
  if (["IMPORTING", "COMPLETED"].includes(batch.status)) {
    throw new HttpError(409, "IMPORT_BATCH_LOCKED", "Ce lot est déjà en cours ou terminé.");
  }
  const capability = getImportCapability(batch.entity_type);
  if (!capability?.confirm_enabled) {
    throw new HttpError(409, "IMPORT_DOMAIN_GATED", capability?.unavailable_reason ?? "Ce domaine est bloqué.");
  }
  const mappingIssues = validateMapping(batch.entity_type, batch.headers, params.mapping);
  if (mappingIssues.length > 0) {
    throw new HttpError(422, "IMPORT_MAPPING_INVALID", "Le mapping est incomplet ou invalide.", mappingIssues);
  }

  const storedRows = await repo.repoGetAllBatchRows(batch.id);
  const normalized = storedRows.map((stored) => ({
    stored,
    result: normalizeImportRow(batch.entity_type, stored.source_data, params.mapping),
  }));
  const legacyKeys = normalized.map((row) => row.result.legacy_key).filter((value): value is string => Boolean(value));
  const crosswalk = await repo.repoFindCrosswalks({
    source_system: batch.source_system,
    entity_type: batch.entity_type,
    legacy_keys: legacyKeys,
  });
  const strongDedupe = await repo.repoFindStrongDuplicates(
    batch.entity_type,
    normalized
      .filter((row) => row.result.legacy_key && row.result.normalized_data)
      .map((row) => ({
        legacy_key: row.result.legacy_key!,
        ...importRowDedupeKeys(batch.entity_type, row.result.normalized_data!),
      }))
  );

  const simulated: repo.SimulatedRow[] = normalized.map(({ stored, result }) => {
    const already = result.legacy_key ? crosswalk.get(result.legacy_key) : null;
    if (already) {
      return {
        id: stored.id,
        legacy_key: result.legacy_key,
        normalized_data: result.normalized_data,
        status: "ALREADY_IMPORTED",
        action: "SKIP",
        issues: [],
        target_id: already.id,
        target_code: already.code,
      };
    }
    if (result.issues.length > 0 || !result.normalized_data || !result.legacy_key) {
      return {
        id: stored.id,
        legacy_key: result.legacy_key,
        normalized_data: result.normalized_data,
        status: "BLOCKED",
        action: "CREATE",
        issues: result.issues,
        target_id: null,
        target_code: null,
      };
    }
    const duplicate = strongDedupe.get(result.legacy_key);
    if (duplicate) {
      const link = params.mapping.duplicate_strategy === "LINK_EXACT";
      return {
        id: stored.id,
        legacy_key: result.legacy_key,
        normalized_data: result.normalized_data,
        status: link ? "VALID" : "DUPLICATE",
        action: link ? "LINK" : "SKIP",
        issues: link ? [] : [{
          code: "EXACT_DUPLICATE_REVIEW",
          message: "Une fiche CERP porte déjà le même identifiant fort. Vérifiez-la avant de choisir le rapprochement automatique.",
          field: null,
        }],
        target_id: duplicate.id,
        target_code: duplicate.code,
      };
    }
    return {
      id: stored.id,
      legacy_key: result.legacy_key,
      normalized_data: result.normalized_data,
      status: "VALID",
      action: "CREATE",
      issues: [],
      target_id: null,
      target_code: null,
    };
  });

  const approved = new Set(params.mapping.approved_decisions);
  const missingDecisions = capability.decisions.filter((decision) => !approved.has(decision.id));
  const summary: ImportBatchSummary = {
    total: simulated.length,
    valid: simulated.filter((row) => row.status === "VALID").length,
    blocked: simulated.filter((row) => row.status === "BLOCKED").length,
    duplicates: simulated.filter((row) => row.status === "DUPLICATE").length,
    already_imported: simulated.filter((row) => row.status === "ALREADY_IMPORTED").length,
    imported: 0,
    linked: 0,
    failed: 0,
  };
  const ready = summary.blocked === 0 && summary.duplicates === 0 && missingDecisions.length === 0;
  const previewHash = sha256(JSON.stringify({
    batch_id: batch.id,
    source_sha256: batch.source_sha256,
    mapping: params.mapping,
    rows: simulated.map((row) => ({
      id: row.id,
      legacy_key: row.legacy_key,
      normalized_data: row.normalized_data,
      status: row.status,
      action: row.action,
      target_id: row.target_id,
    })),
  }));
  await repo.repoSaveSimulation({
    batch_id: batch.id,
    mapping: params.mapping,
    preview_hash: previewHash,
    status: ready ? "READY" : "SIMULATED",
    summary,
    rows: simulated,
  });
  await auditBatch(params.audit, "data-import.batch.preview", batch.id, {
    entity_type: batch.entity_type,
    summary,
    missing_decisions: missingDecisions.map((decision) => decision.id),
    preview_hash: previewHash,
  });
  return {
    batch: await getImportBatch(batch.id),
    preview_hash: previewHash,
    summary,
    missing_decisions: missingDecisions,
    ready,
  };
}

async function processBatch(batchId: string, audit: ImportAuditContext) {
  const batch = await repo.repoGetBatch(batchId);
  if (!batch || batch.status !== "IMPORTING") return;
  try {
    await repo.repoResetInterruptedRows(batchId);
    while (true) {
      const rows = await repo.repoClaimNextRows(batchId, 25);
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          if (!row.legacy_key) throw new HttpError(422, "LEGACY_KEY_EMPTY", "Référence CLIPPER vide.");
          if (row.action === "LINK") {
            if (!row.target_id) throw new HttpError(409, "IMPORT_LINK_TARGET_MISSING", "La fiche CERP à rapprocher est introuvable.");
            await repo.repoUpsertCrosswalk({
              source_system: batch.source_system,
              entity_type: batch.entity_type,
              legacy_key: row.legacy_key,
              target_id: row.target_id,
              target_code: row.target_code,
              batch_id: batch.id,
              row_id: row.id,
              linked_by: audit.user_id,
            });
            await repo.repoCompleteRow({ row_id: row.id, status: "LINKED", target_id: row.target_id, target_code: row.target_code });
            continue;
          }
          if (!row.normalized_data) throw new HttpError(422, "IMPORT_NORMALIZED_DATA_MISSING", "Données normalisées absentes.");
          const idempotencyKey = importRowIdempotencyKey({
            source_system: batch.source_system,
            entity_type: batch.entity_type,
            legacy_key: row.legacy_key,
          });
          const target = await createImportTarget({
            entity_type: batch.entity_type,
            normalized_data: row.normalized_data,
            idempotency_key: idempotencyKey,
            audit,
          });
          await repo.repoUpsertCrosswalk({
            source_system: batch.source_system,
            entity_type: batch.entity_type,
            legacy_key: row.legacy_key,
            target_id: target.id,
            target_code: target.code,
            batch_id: batch.id,
            row_id: row.id,
            linked_by: audit.user_id,
          });
          await repo.repoCompleteRow({ row_id: row.id, status: "IMPORTED", target_id: target.id, target_code: target.code });
        } catch (error) {
          await repo.repoFailRow(row.id, safeError(error));
        }
      }
    }
    const summary = await repo.repoFinishBatch(batchId);
    await auditBatch(audit, "data-import.batch.complete", batchId, { entity_type: batch.entity_type, summary });
  } catch (error) {
    const issue = safeError(error);
    await repo.repoMarkBatchFailed(batchId, `${issue.code}: ${issue.message}`);
    try {
      await auditBatch(audit, "data-import.batch.failed", batchId, { entity_type: batch.entity_type, error_code: issue.code });
    } catch {
      // The batch status is already persisted; audit failure must not hide it.
    }
  }
}

export async function confirmImportBatch(params: {
  id: string;
  expected_preview_hash: string;
  idempotency_key: string;
  audit: ImportAuditContext;
}) {
  const requestHash = sha256(JSON.stringify({
    batch_id: params.id,
    expected_preview_hash: params.expected_preview_hash,
  }));
  const result = await repo.repoStartBatchImport({
    id: params.id,
    expected_preview_hash: params.expected_preview_hash,
    actor_user_id: params.audit.user_id,
    idempotency_key: params.idempotency_key,
    request_hash: requestHash,
  });
  if (!result.replayed && result.response.status === "IMPORTING") {
    setImmediate(() => {
      void processBatch(params.id, params.audit);
    });
  }
  return result;
}

function csvCell(value: unknown): string {
  const raw = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

export async function buildImportReportCsv(id: string): Promise<{ filename: string; csv: string }> {
  const batch = await repo.repoGetBatch(id);
  if (!batch) throw new HttpError(404, "IMPORT_BATCH_NOT_FOUND", "Lot d’import introuvable.");
  const rows = await repo.repoReportRows(id);
  const lines = [
    ["ligne", "reference_clipper", "statut", "action", "id_cerp", "code_cerp", "erreurs"].map(csvCell).join(";"),
    ...rows.map((row) => [
      row.row_number,
      row.legacy_key,
      row.status,
      row.action,
      row.target_id,
      row.target_code,
      row.issues.map((issue) => `${issue.code}: ${issue.message}${issue.field ? ` [${issue.field}]` : ""}`).join(" | "),
    ].map(csvCell).join(";")),
  ];
  return {
    filename: `rapport-import-${batch.entity_type.toLowerCase()}-${batch.id}.csv`,
    csv: `\uFEFF${lines.join("\r\n")}`,
  };
}
