import pool from "../../../config/database";
import type {
  MigrationLedgerSnapshot,
  QueueSnapshot,
} from "../types/operations-console.types";

type Queryable = Pick<typeof pool, "query">;

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function repoMigrationLedger(
  database: Queryable = pool,
): Promise<MigrationLedgerSnapshot> {
  const startedAt = Date.now();
  const exists = await database.query<{ registry: string | null }>(
    "SELECT to_regclass('public.cerp_schema_migrations')::text AS registry",
  );
  if (!exists.rows[0]?.registry) {
    return { registry_exists: false, rows: [], latency_ms: Date.now() - startedAt };
  }
  const result = await database.query<{
    filename: string;
    sha256: string;
    applied_at: Date | string;
  }>(
    `SELECT filename, sha256, applied_at
       FROM public.cerp_schema_migrations
      ORDER BY filename`,
  );
  return {
    registry_exists: true,
    rows: result.rows.map((row) => ({
      filename: row.filename,
      sha256: row.sha256,
      applied_at: new Date(row.applied_at).toISOString(),
    })),
    latency_ms: Date.now() - startedAt,
  };
}

async function optionalQueue(
  id: QueueSnapshot["id"],
  relation: string,
  sql: string,
  database: Queryable,
): Promise<QueueSnapshot> {
  const startedAt = Date.now();
  try {
    const exists = await database.query<{ registry: string | null }>(
      "SELECT to_regclass($1)::text AS registry",
      [relation],
    );
    if (!exists.rows[0]?.registry) {
      return {
        id,
        available: false,
        pending: 0,
        failures: 0,
        oldest_pending_at: null,
        last_success_at: null,
        last_error_at: null,
        latency_ms: Date.now() - startedAt,
        reason_code: "QUEUE_SCHEMA_NOT_INSTALLED",
      };
    }
    const result = await database.query<Record<string, unknown>>(sql);
    const row = result.rows[0] ?? {};
    return {
      id,
      available: true,
      pending: integer(row.pending),
      failures: integer(row.failures),
      oldest_pending_at: isoOrNull(row.oldest_pending_at),
      last_success_at: isoOrNull(row.last_success_at),
      last_error_at: isoOrNull(row.last_error_at),
      latency_ms: Date.now() - startedAt,
      reason_code: null,
    };
  } catch {
    return {
      id,
      available: false,
      pending: 0,
      failures: 0,
      oldest_pending_at: null,
      last_success_at: null,
      last_error_at: null,
      latency_ms: Date.now() - startedAt,
      reason_code: "QUEUE_PROBE_FAILED",
    };
  }
}

export async function repoQueueSnapshots(database: Queryable = pool): Promise<readonly QueueSnapshot[]> {
  return Promise.all([
    optionalQueue(
      "advanced_reminders",
      "public.adv_reminder_suggestions",
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('APPROVED','CLAIMED','FAILED_RETRYABLE'))::int AS pending,
         COUNT(*) FILTER (WHERE status = 'FAILED_FINAL')::int AS failures,
         MIN(created_at) FILTER (WHERE status IN ('APPROVED','CLAIMED','FAILED_RETRYABLE')) AS oldest_pending_at,
         MAX(sent_at) FILTER (WHERE status = 'SENT') AS last_success_at,
         MAX(updated_at) FILTER (WHERE status IN ('FAILED_RETRYABLE','FAILED_FINAL')) AS last_error_at
       FROM public.adv_reminder_suggestions`,
      database,
    ),
    optionalQueue(
      "webhook_delivery",
      "public.api_webhook_deliveries",
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('PENDING','PROCESSING','RETRY'))::int AS pending,
         COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS failures,
         MIN(created_at) FILTER (WHERE status IN ('PENDING','PROCESSING','RETRY')) AS oldest_pending_at,
         MAX(delivered_at) FILTER (WHERE status = 'DELIVERED') AS last_success_at,
         MAX(updated_at) FILTER (WHERE last_error_code IS NOT NULL) AS last_error_at
       FROM public.api_webhook_deliveries`,
      database,
    ),
    optionalQueue(
      "electronic_invoicing",
      "public.einvoice_documents",
      `SELECT
         COUNT(*) FILTER (
           WHERE provider_document_id IS NULL
             AND (next_retry_at IS NULL OR next_retry_at <= now())
         )::int AS pending,
         COUNT(*) FILTER (WHERE last_error_code IS NOT NULL)::int AS failures,
         MIN(created_at) FILTER (WHERE provider_document_id IS NULL) AS oldest_pending_at,
         MAX(updated_at) FILTER (WHERE provider_document_id IS NOT NULL AND last_error_code IS NULL) AS last_success_at,
         MAX(updated_at) FILTER (WHERE last_error_code IS NOT NULL) AS last_error_at
       FROM public.einvoice_documents`,
      database,
    ),
  ]);
}
