import crypto from "node:crypto";

import type { PoolClient } from "pg";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type {
  ImportBatchRow,
  ImportBatchStatus,
  ImportBatchSummary,
  ImportEntityType,
  ImportIssue,
  ImportMapping,
  ImportRowAction,
  ImportRowStatus,
  ImportStoredRow,
  ImportTargetResult,
} from "../types/import-assistant.types";
import { normalizeImportName } from "../domain/import-normalization";

type DbQueryer = Pick<PoolClient, "query">;

const EMPTY_SUMMARY: ImportBatchSummary = {
  total: 0,
  valid: 0,
  blocked: 0,
  duplicates: 0,
  already_imported: 0,
  imported: 0,
  linked: 0,
  failed: 0,
};

function mapSummary(value: unknown): ImportBatchSummary {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const n = (key: keyof ImportBatchSummary) => Number(source[key] ?? 0) || 0;
  return {
    total: n("total"),
    valid: n("valid"),
    blocked: n("blocked"),
    duplicates: n("duplicates"),
    already_imported: n("already_imported"),
    imported: n("imported"),
    linked: n("linked"),
    failed: n("failed"),
  };
}

function mapBatch(row: Record<string, unknown>): ImportBatchRow {
  return {
    id: String(row.id),
    entity_type: row.entity_type as ImportEntityType,
    status: row.status as ImportBatchStatus,
    source_system: String(row.source_system),
    source_name: String(row.source_name),
    source_sha256: String(row.source_sha256),
    source_size: Number(row.source_size),
    source_mime: row.source_mime == null ? null : String(row.source_mime),
    sheet_name: String(row.sheet_name),
    headers: Array.isArray(row.headers) ? row.headers.map(String) : [],
    mapping: row.mapping && typeof row.mapping === "object" ? row.mapping as ImportMapping : null,
    preview_hash: row.preview_hash == null ? null : String(row.preview_hash),
    summary: mapSummary(row.summary),
    last_error: row.last_error == null ? null : String(row.last_error),
    created_by: Number(row.created_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
  };
}

function batchSelect() {
  return `
    SELECT
      id::text AS id, source_system, entity_type, status, source_name, source_sha256,
      source_size, source_mime, sheet_name, headers, mapping, preview_hash, summary,
      last_error, created_by, created_at::text AS created_at, updated_at::text AS updated_at,
      completed_at::text AS completed_at
    FROM public.data_import_batches
  `;
}

export async function repoFindBatchBySource(params: {
  source_system: string;
  entity_type: ImportEntityType;
  source_sha256: string;
  sheet_name: string;
}): Promise<ImportBatchRow | null> {
  const result = await db.query(
    `${batchSelect()}
     WHERE source_system = $1 AND entity_type = $2 AND source_sha256 = $3 AND sheet_name = $4
     LIMIT 1`,
    [params.source_system, params.entity_type, params.source_sha256, params.sheet_name]
  );
  return result.rows[0] ? mapBatch(result.rows[0]) : null;
}

export async function repoPurgeExpiredStaging(): Promise<number> {
  const result = await db.query<{ affected: string }>(
    "SELECT public.fn_purge_expired_import_staging()::text AS affected"
  );
  return Number(result.rows[0]?.affected ?? 0) || 0;
}

export async function repoCreateBatch(params: {
  source_system: string;
  entity_type: ImportEntityType;
  source_name: string;
  source_sha256: string;
  source_size: number;
  source_mime: string | null;
  sheet_name: string;
  headers: string[];
  rows: Array<Record<string, unknown>>;
  created_by: number;
}): Promise<ImportBatchRow> {
  const client = await db.connect();
  const id = crypto.randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.data_import_batches (
         id, source_system, entity_type, status, source_name, source_sha256, source_size,
         source_mime, sheet_name, headers, summary, created_by
       ) VALUES ($1::uuid,$2,$3,'UPLOADED',$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
      [
        id,
        params.source_system,
        params.entity_type,
        params.source_name,
        params.source_sha256,
        params.source_size,
        params.source_mime,
        params.sheet_name,
        JSON.stringify(params.headers),
        JSON.stringify({ ...EMPTY_SUMMARY, total: params.rows.length }),
        params.created_by,
      ]
    );

    for (let start = 0; start < params.rows.length; start += 1000) {
      const chunk = params.rows.slice(start, start + 1000).map((source_data, index) => ({
        row_number: start + index + 2,
        source_data,
      }));
      await client.query(
        `INSERT INTO public.data_import_rows (batch_id, row_number, source_data)
         SELECT $1::uuid, x.row_number, x.source_data
         FROM jsonb_to_recordset($2::jsonb) AS x(row_number integer, source_data jsonb)`,
        [id, JSON.stringify(chunk)]
      );
    }
    await client.query("COMMIT");
    const created = await repoGetBatch(id);
    if (!created) throw new Error("Failed to reload import batch");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoGetBatch(id: string): Promise<ImportBatchRow | null> {
  const result = await db.query(`${batchSelect()} WHERE id = $1::uuid`, [id]);
  return result.rows[0] ? mapBatch(result.rows[0]) : null;
}

export async function repoListBatches(params: {
  entity_type?: ImportEntityType;
  page: number;
  pageSize: number;
}): Promise<{ items: ImportBatchRow[]; total: number }> {
  const where = params.entity_type ? "WHERE entity_type = $1" : "";
  const baseValues: unknown[] = params.entity_type ? [params.entity_type] : [];
  const count = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM public.data_import_batches ${where}`,
    baseValues
  );
  const limitIndex = baseValues.length + 1;
  const offsetIndex = baseValues.length + 2;
  const result = await db.query(
    `${batchSelect()} ${where}
     ORDER BY created_at DESC
     LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    [...baseValues, params.pageSize, (params.page - 1) * params.pageSize]
  );
  return { items: result.rows.map(mapBatch), total: count.rows[0]?.total ?? 0 };
}

export async function repoGetAllBatchRows(id: string): Promise<ImportStoredRow[]> {
  const result = await db.query(
    `SELECT id::text AS id, batch_id::text AS batch_id, row_number, legacy_key, source_data,
            normalized_data, status, action, issues, target_id, target_code, attempts
     FROM public.data_import_rows
     WHERE batch_id = $1::uuid
     ORDER BY row_number`,
    [id]
  );
  return result.rows as ImportStoredRow[];
}

export async function repoListBatchRows(params: {
  id: string;
  status?: ImportRowStatus;
  page: number;
  pageSize: number;
}): Promise<{ items: ImportStoredRow[]; total: number }> {
  const values: unknown[] = [params.id];
  const statusWhere = params.status ? ` AND status = $${values.push(params.status)}` : "";
  const count = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM public.data_import_rows WHERE batch_id = $1::uuid${statusWhere}`,
    values
  );
  values.push(params.pageSize, (params.page - 1) * params.pageSize);
  const result = await db.query(
    `SELECT id::text AS id, batch_id::text AS batch_id, row_number, legacy_key, source_data,
            normalized_data, status, action, issues, target_id, target_code, attempts
     FROM public.data_import_rows
     WHERE batch_id = $1::uuid${statusWhere}
     ORDER BY row_number
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return { items: result.rows as ImportStoredRow[], total: count.rows[0]?.total ?? 0 };
}

export type SimulatedRow = {
  id: string;
  legacy_key: string | null;
  normalized_data: Record<string, unknown> | null;
  status: ImportRowStatus;
  action: ImportRowAction;
  issues: ImportIssue[];
  target_id: string | null;
  target_code: string | null;
};

export async function repoSaveSimulation(params: {
  batch_id: string;
  mapping: ImportMapping;
  preview_hash: string;
  status: "SIMULATED" | "READY";
  summary: ImportBatchSummary;
  rows: SimulatedRow[];
}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (let start = 0; start < params.rows.length; start += 1000) {
      const chunk = params.rows.slice(start, start + 1000);
      await client.query(
        `UPDATE public.data_import_rows AS row
         SET legacy_key = data.legacy_key,
             normalized_data = data.normalized_data,
             status = data.status,
             action = data.action,
             issues = data.issues,
             target_id = data.target_id,
             target_code = data.target_code,
             attempts = 0,
             processing_started_at = NULL,
             updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS data(
           id bigint, legacy_key text, normalized_data jsonb, status text, action text,
           issues jsonb, target_id text, target_code text
         )
         WHERE row.batch_id = $1::uuid AND row.id = data.id`,
        [params.batch_id, JSON.stringify(chunk)]
      );
    }
    await client.query(
      `UPDATE public.data_import_batches
       SET mapping = $2::jsonb, preview_hash = $3, status = $4, summary = $5::jsonb,
           last_error = NULL, completed_at = NULL, updated_at = now()
       WHERE id = $1::uuid`,
      [params.batch_id, JSON.stringify(params.mapping), params.preview_hash, params.status, JSON.stringify(params.summary)]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoFindCrosswalks(params: {
  source_system: string;
  entity_type: ImportEntityType;
  legacy_keys: string[];
}): Promise<Map<string, ImportTargetResult>> {
  if (params.legacy_keys.length === 0) return new Map();
  const result = await db.query<{ legacy_key: string; target_id: string; target_code: string | null }>(
    `SELECT legacy_key, target_id, target_code
     FROM public.data_import_crosswalk
     WHERE source_system = $1 AND entity_type = $2 AND legacy_key = ANY($3::text[])`,
    [params.source_system, params.entity_type, params.legacy_keys]
  );
  return new Map(result.rows.map((row) => [row.legacy_key, { id: row.target_id, code: row.target_code }]));
}

export type StrongDedupeInput = {
  legacy_key: string;
  siret: string | null;
  secondary: string | null;
  name: string | null;
};

export async function repoFindStrongDuplicates(
  entityType: ImportEntityType,
  inputs: StrongDedupeInput[]
): Promise<Map<string, ImportTargetResult>> {
  const strong = inputs.filter((input) => input.siret || input.secondary || input.name);
  if (strong.length === 0) return new Map();
  const sirets = [...new Set(strong.map((input) => input.siret).filter((value): value is string => Boolean(value)))];
  const secondary = [...new Set(strong.map((input) => input.secondary?.toUpperCase()).filter((value): value is string => Boolean(value)))];
  const names = [...new Set(strong.map((input) => input.name).filter((value): value is string => Boolean(value)))];
  let rows: Array<{
    target_id: string;
    target_code: string | null;
    siret: string | null;
    secondary: string | null;
    name: string | null;
    name_count: string | number;
  }> = [];

  if (entityType === "CLIENT") {
    const result = await db.query(
      `WITH candidates AS (
         SELECT c.*,
                regexp_replace(
                  translate(upper(c.company_name), 'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝŸ', 'AAAAAACEEEEIIIINOOOOOUUUUYY'),
                  '[^0-9A-Z]', '', 'g'
                ) AS normalized_name
         FROM public.clients c
       )
       SELECT c.client_id::text AS target_id,
              COALESCE(NULLIF(btrim(to_jsonb(c)->>'client_code'), ''), NULLIF(btrim(to_jsonb(c)->>'code_client'), '')) AS target_code,
              c.siret, upper(c.vat_number) AS secondary, c.normalized_name AS name,
              count(*) OVER (PARTITION BY c.normalized_name) AS name_count
       FROM candidates c
       WHERE ($1::text[] <> '{}' AND c.siret = ANY($1::text[]))
          OR ($2::text[] <> '{}' AND upper(c.vat_number) = ANY($2::text[]))
          OR ($3::text[] <> '{}' AND c.normalized_name = ANY($3::text[]))`,
      [sirets, secondary, names]
    );
    rows = result.rows;
  } else if (entityType === "FOURNISSEUR") {
    const result = await db.query(
      `WITH candidates AS (
         SELECT f.*,
                regexp_replace(
                  translate(upper(COALESCE(f.nom, f.raison_sociale)), 'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝŸ', 'AAAAAACEEEEIIIINOOOOOUUUUYY'),
                  '[^0-9A-Z]', '', 'g'
                ) AS normalized_name
         FROM public.fournisseurs f
       )
       SELECT f.id::text AS target_id, COALESCE(f.code, f.code_fournisseur) AS target_code,
              f.siret, upper(f.tva) AS secondary, f.normalized_name AS name,
              count(*) OVER (PARTITION BY f.normalized_name) AS name_count
       FROM candidates f
       WHERE ($1::text[] <> '{}' AND f.siret = ANY($1::text[]))
          OR ($2::text[] <> '{}' AND upper(f.tva) = ANY($2::text[]))
          OR ($3::text[] <> '{}' AND f.normalized_name = ANY($3::text[]))`,
      [sirets, secondary, names]
    );
    rows = result.rows;
  } else if (entityType === "MACHINE") {
    const result = await db.query(
      `SELECT m.id::text AS target_id, m.code AS target_code, NULL::text AS siret,
              upper(m.serial_number) AS secondary, NULL::text AS name, 0::int AS name_count
       FROM public.machines m
       WHERE $1::text[] <> '{}' AND upper(m.serial_number) = ANY($1::text[])`,
      [secondary]
    );
    rows = result.rows;
  }

  const matches = new Map<string, ImportTargetResult>();
  for (const input of strong) {
    const target = rows.find((row) =>
      (input.siret && row.siret === input.siret)
      || (input.secondary && row.secondary === input.secondary.toUpperCase())
      || (
        input.name
        && normalizeImportName(row.name) === input.name
        && Number(row.name_count) === 1
      )
    );
    if (target) matches.set(input.legacy_key, { id: target.target_id, code: target.target_code });
  }
  return matches;
}

export async function repoStartBatchImport(params: {
  id: string;
  expected_preview_hash: string;
  actor_user_id: number;
  idempotency_key: string;
  request_hash: string;
}): Promise<{ replayed: boolean; response: Record<string, unknown> }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const replay = await client.query<{ request_hash: string; response_body: Record<string, unknown> }>(
      `SELECT request_hash, response_body
       FROM public.data_import_confirm_idempotency
       WHERE actor_user_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [params.actor_user_id, params.idempotency_key]
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== params.request_hash) {
        throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé d’idempotence a déjà servi avec une autre confirmation.");
      }
      await client.query("COMMIT");
      return { replayed: true, response: replay.rows[0].response_body };
    }

    const batch = await client.query<{ status: ImportBatchStatus; preview_hash: string | null }>(
      `SELECT status, preview_hash FROM public.data_import_batches WHERE id = $1::uuid FOR UPDATE`,
      [params.id]
    );
    const current = batch.rows[0];
    if (!current) throw new HttpError(404, "IMPORT_BATCH_NOT_FOUND", "Lot d’import introuvable.");
    if (current.preview_hash !== params.expected_preview_hash) {
      throw new HttpError(409, "IMPORT_PREVIEW_STALE", "La simulation a changé. Relancez-la avant de confirmer.");
    }
    if (!["READY", "IMPORTING", "COMPLETED", "COMPLETED_WITH_ERRORS"].includes(current.status)) {
      throw new HttpError(409, "IMPORT_BATCH_NOT_READY", "Le lot doit être entièrement simulé et sans blocage avant confirmation.");
    }
    const response = { batch_id: params.id, status: current.status === "READY" ? "IMPORTING" : current.status };
    if (current.status === "READY") {
      await client.query(
        `UPDATE public.data_import_batches SET status = 'IMPORTING', last_error = NULL, updated_at = now()
         WHERE id = $1::uuid`,
        [params.id]
      );
    }
    await client.query(
      `INSERT INTO public.data_import_confirm_idempotency
         (actor_user_id, idempotency_key, batch_id, request_hash, response_status, response_body)
       VALUES ($1,$2,$3::uuid,$4,202,$5::jsonb)`,
      [params.actor_user_id, params.idempotency_key, params.id, params.request_hash, JSON.stringify(response)]
    );
    await client.query("COMMIT");
    return { replayed: false, response };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoResetInterruptedRows(batchId: string) {
  await db.query(
    `UPDATE public.data_import_rows
     SET status = 'VALID', attempts = attempts + 1, processing_started_at = NULL, updated_at = now()
     WHERE batch_id = $1::uuid AND status = 'PROCESSING'
       AND processing_started_at < now() - interval '10 minutes'`,
    [batchId]
  );
}

export async function repoClaimNextRows(batchId: string, limit = 25): Promise<ImportStoredRow[]> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `WITH next_rows AS (
         SELECT id
         FROM public.data_import_rows
         WHERE batch_id = $1::uuid AND status = 'VALID'
         ORDER BY row_number
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE public.data_import_rows AS row
       SET status = 'PROCESSING', processing_started_at = now(), attempts = attempts + 1, updated_at = now()
       FROM next_rows
       WHERE row.id = next_rows.id
       RETURNING row.id::text AS id, row.batch_id::text AS batch_id, row.row_number, row.legacy_key,
                 row.source_data, row.normalized_data, row.status, row.action, row.issues,
                 row.target_id, row.target_code, row.attempts`,
      [batchId, limit]
    );
    await client.query("COMMIT");
    return claimed.rows as ImportStoredRow[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoUpsertCrosswalk(params: {
  source_system: string;
  entity_type: ImportEntityType;
  legacy_key: string;
  target_id: string;
  target_code: string | null;
  batch_id: string;
  row_id: string;
  linked_by: number;
}) {
  const inserted = await db.query(
    `INSERT INTO public.data_import_crosswalk
       (source_system, entity_type, legacy_key, target_id, target_code, batch_id, row_id, linked_by)
     VALUES ($1,$2,$3,$4,$5,$6::uuid,$7,$8)
     ON CONFLICT (source_system, entity_type, legacy_key) DO NOTHING
     RETURNING target_id, target_code`,
    [
      params.source_system,
      params.entity_type,
      params.legacy_key,
      params.target_id,
      params.target_code,
      params.batch_id,
      params.row_id,
      params.linked_by,
    ]
  );
  if (inserted.rows[0]) return;
  const existing = await db.query<{ target_id: string; target_code: string | null }>(
    `SELECT target_id, target_code FROM public.data_import_crosswalk
     WHERE source_system = $1 AND entity_type = $2 AND legacy_key = $3`,
    [params.source_system, params.entity_type, params.legacy_key]
  );
  if (!existing.rows[0] || existing.rows[0].target_id !== params.target_id) {
    throw new HttpError(409, "IMPORT_CROSSWALK_CONFLICT", "La référence CLIPPER est déjà reliée à une autre fiche CERP.");
  }
}

export async function repoCompleteRow(params: {
  row_id: string;
  status: "IMPORTED" | "LINKED";
  target_id: string;
  target_code: string | null;
}) {
  await db.query(
    `UPDATE public.data_import_rows
     SET status = $2, target_id = $3, target_code = $4, issues = '[]'::jsonb,
         processing_started_at = NULL, updated_at = now()
     WHERE id = $1`,
    [params.row_id, params.status, params.target_id, params.target_code]
  );
}

export async function repoFailRow(rowId: string, issue: ImportIssue) {
  await db.query(
    `UPDATE public.data_import_rows
     SET status = 'FAILED', issues = $2::jsonb, processing_started_at = NULL, updated_at = now()
     WHERE id = $1`,
    [rowId, JSON.stringify([issue])]
  );
}

export async function repoFinishBatch(batchId: string) {
  const counts = await db.query<{ status: ImportRowStatus; count: number }>(
    `SELECT status, count(*)::int AS count
     FROM public.data_import_rows WHERE batch_id = $1::uuid GROUP BY status`,
    [batchId]
  );
  const byStatus = new Map(counts.rows.map((row) => [row.status, row.count]));
  const summary: ImportBatchSummary = {
    total: [...byStatus.values()].reduce((total, count) => total + count, 0),
    valid: byStatus.get("VALID") ?? 0,
    blocked: byStatus.get("BLOCKED") ?? 0,
    duplicates: byStatus.get("DUPLICATE") ?? 0,
    already_imported: byStatus.get("ALREADY_IMPORTED") ?? 0,
    imported: byStatus.get("IMPORTED") ?? 0,
    linked: byStatus.get("LINKED") ?? 0,
    failed: byStatus.get("FAILED") ?? 0,
  };
  const failed = summary.failed > 0 || summary.blocked > 0 || summary.duplicates > 0;
  await db.query(
    `UPDATE public.data_import_batches
     SET status = $2, summary = $3::jsonb, completed_at = now(), updated_at = now(),
         last_error = CASE WHEN $4::boolean THEN 'Certaines lignes nécessitent une intervention.' ELSE NULL END
     WHERE id = $1::uuid`,
    [batchId, failed ? "COMPLETED_WITH_ERRORS" : "COMPLETED", JSON.stringify(summary), failed]
  );
  return summary;
}

export async function repoMarkBatchFailed(batchId: string, message: string) {
  await db.query(
    `UPDATE public.data_import_batches
     SET status = 'FAILED', last_error = $2, updated_at = now()
     WHERE id = $1::uuid`,
    [batchId, message.slice(0, 2000)]
  );
}

export async function repoReportRows(batchId: string): Promise<Array<{
  row_number: number;
  legacy_key: string | null;
  status: ImportRowStatus;
  action: ImportRowAction;
  target_id: string | null;
  target_code: string | null;
  issues: ImportIssue[];
}>> {
  const result = await db.query(
    `SELECT row_number, legacy_key, status, action, target_id, target_code, issues
     FROM public.data_import_rows WHERE batch_id = $1::uuid ORDER BY row_number`,
    [batchId]
  );
  return result.rows;
}

export async function repoInsertBatchAudit(
  queryer: DbQueryer,
  params: {
    user_id: number;
    action: string;
    batch_id: string;
    details: Record<string, unknown>;
  }
) {
  await repoInsertAuditLog({
    user_id: params.user_id,
    body: {
      event_type: "ACTION",
      action: params.action,
      page_key: "import-assistant",
      entity_type: "DATA_IMPORT_BATCH",
      entity_id: params.batch_id,
      path: "/api/v1/import-assistant",
      client_session_id: null,
      details: params.details,
    },
    ip: null,
    user_agent: null,
    device_type: null,
    os: null,
    browser: null,
    tx: queryer,
  });
}
