import type { PoolClient } from "pg";

import pool from "../../../config/database";
import type {
  AccessReview,
  AccessReviewCandidate,
  AccessReviewDecision,
  AccessReviewHeader,
  AccessReviewItem,
  AccessReviewRiskLevel,
  AccessReviewRiskReason,
} from "../types/access-review.types";

type DbQueryer = Pick<PoolClient, "query">;

type HeaderRow = AccessReviewHeader & { request_hash: string };

function toInt(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapHeader(row: HeaderRow): AccessReviewHeader {
  return {
    id: row.id,
    period_start: row.period_start,
    period_end: row.period_end,
    status: row.status,
    inactivity_days: toInt(row.inactivity_days, "inactivity_days"),
    login_failure_window_days: toInt(row.login_failure_window_days, "login_failure_window_days"),
    failed_login_threshold: toInt(row.failed_login_threshold, "failed_login_threshold"),
    due_at: row.due_at,
    created_by: toInt(row.created_by, "created_by"),
    created_at: row.created_at,
    closed_by: row.closed_by == null ? null : toInt(row.closed_by, "closed_by"),
    closed_at: row.closed_at,
  };
}

type ItemRow = {
  review_id: string;
  user_id: number | string;
  snapshot_username: string;
  snapshot_status: string | null;
  snapshot_roles: unknown;
  is_superadmin: boolean;
  last_activity_at: string | null;
  failed_login_count: number | string;
  last_failed_login_at: string | null;
  exceptional_module_keys: unknown;
  risk_reasons: unknown;
  risk_level: AccessReviewRiskLevel;
  decision: AccessReviewDecision | null;
  decision_rationale: string | null;
  decided_by: number | string | null;
  decided_at: string | null;
};

function mapItem(row: ItemRow): AccessReviewItem {
  return {
    review_id: row.review_id,
    user_id: toInt(row.user_id, "user_id"),
    username: row.snapshot_username,
    status: row.snapshot_status,
    roles: stringArray(row.snapshot_roles),
    is_superadmin: row.is_superadmin === true,
    last_activity_at: row.last_activity_at,
    failed_login_count: toInt(row.failed_login_count, "failed_login_count"),
    last_failed_login_at: row.last_failed_login_at,
    exceptional_module_keys: stringArray(row.exceptional_module_keys),
    risk_reasons: stringArray(row.risk_reasons) as AccessReviewRiskReason[],
    risk_level: row.risk_level,
    decision: row.decision,
    decision_rationale: row.decision_rationale,
    decided_by: row.decided_by == null ? null : toInt(row.decided_by, "decided_by"),
    decided_at: row.decided_at,
  };
}

const HEADER_SELECT = `
  id::text AS id,
  period_start::text AS period_start,
  period_end::text AS period_end,
  status,
  inactivity_days,
  login_failure_window_days,
  failed_login_threshold,
  due_at::text AS due_at,
  created_by,
  created_at::text AS created_at,
  closed_by,
  closed_at::text AS closed_at,
  request_hash
`;

const ITEM_SELECT = `
  review_id::text AS review_id,
  user_id,
  snapshot_username,
  snapshot_status,
  snapshot_roles,
  is_superadmin,
  last_activity_at::text AS last_activity_at,
  failed_login_count,
  last_failed_login_at::text AS last_failed_login_at,
  exceptional_module_keys,
  risk_reasons,
  risk_level,
  decision,
  decision_rationale,
  decided_by,
  decided_at::text AS decided_at
`;

export async function repoFindReviewByIdempotency(
  tx: DbQueryer,
  actorUserId: number,
  idempotencyKey: string
): Promise<HeaderRow | null> {
  const { rows } = await tx.query<HeaderRow>(
    `SELECT ${HEADER_SELECT}
     FROM public.app_access_reviews
     WHERE created_by = $1 AND idempotency_key = $2
     FOR UPDATE`,
    [actorUserId, idempotencyKey]
  );
  return rows[0] ?? null;
}

export async function repoFindOpenReview(tx: DbQueryer): Promise<HeaderRow | null> {
  const { rows } = await tx.query<HeaderRow>(
    `SELECT ${HEADER_SELECT}
     FROM public.app_access_reviews
     WHERE status = 'OPEN'
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`,
  );
  return rows[0] ?? null;
}

export async function repoInsertReview(
  tx: DbQueryer,
  params: {
    id: string;
    period_start: string;
    period_end: string;
    inactivity_days: number;
    login_failure_window_days: number;
    failed_login_threshold: number;
    due_at: string;
    created_by: number;
    idempotency_key: string;
    request_hash: string;
  }
): Promise<void> {
  await tx.query(
    `INSERT INTO public.app_access_reviews (
       id, period_start, period_end, inactivity_days, login_failure_window_days,
       failed_login_threshold, due_at, created_by, idempotency_key, request_hash
     ) VALUES ($1::uuid,$2::timestamptz,$3::timestamptz,$4,$5,$6,$7::timestamptz,$8,$9,$10)`,
    [
      params.id,
      params.period_start,
      params.period_end,
      params.inactivity_days,
      params.login_failure_window_days,
      params.failed_login_threshold,
      params.due_at,
      params.created_by,
      params.idempotency_key,
      params.request_hash,
    ]
  );
}

export async function repoLockReviewCreation(tx: DbQueryer): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('cerp:access-review:create'))");
}

export async function repoListReviewCandidates(
  tx: DbQueryer,
  params: { inactivity_cutoff: string; login_failure_cutoff: string }
): Promise<AccessReviewCandidate[]> {
  const { rows } = await tx.query<{
    user_id: number | string;
    username: string;
    status: string | null;
    roles: unknown;
    is_superadmin: boolean;
    last_activity_at: string | null;
    failed_login_count: number | string;
    last_failed_login_at: string | null;
    exceptional_module_keys: unknown;
    inactive: boolean;
  }>(
    `WITH role_summary AS (
       SELECT u.id AS user_id,
              COALESCE(array_agg(DISTINCT ura.role_key) FILTER (WHERE ura.role_key IS NOT NULL), '{}') AS roles
       FROM public.users u
       LEFT JOIN public.user_role_assignments ura ON ura.user_id = u.id
       GROUP BY u.id
     ), access_summary AS (
       SELECT a.user_id, array_agg(a.module_key ORDER BY a.module_key) AS module_keys
       FROM public.app_module_user_access a
       JOIN public.app_modules m ON m.module_key = a.module_key
       WHERE a.access = 'GRANTED'
         AND m.enabled_by_default = false
       GROUP BY a.user_id
     ), failure_summary AS (
       SELECT user_id,
              count(*)::int AS failed_login_count,
              max(created_at)::text AS last_failed_login_at
       FROM public.auth_login_logs
       WHERE success = false
         AND user_id IS NOT NULL
         AND created_at >= $2::timestamptz
       GROUP BY user_id
     )
     SELECT
       u.id AS user_id,
       u.username,
       u.status,
       COALESCE(r.roles, '{}') AS roles,
       COALESCE(u.is_superadmin, false) AS is_superadmin,
       u.last_login::text AS last_activity_at,
       COALESCE(f.failed_login_count, 0) AS failed_login_count,
       f.last_failed_login_at,
       COALESCE(a.module_keys, '{}') AS exceptional_module_keys,
       (COALESCE(u.last_login, u.created_at) < $1::timestamptz) AS inactive
     FROM public.users u
     LEFT JOIN role_summary r ON r.user_id = u.id
     LEFT JOIN access_summary a ON a.user_id = u.id
     LEFT JOIN failure_summary f ON f.user_id = u.id
     ORDER BY u.username, u.id`,
    [params.inactivity_cutoff, params.login_failure_cutoff]
  );
  return rows.map((row) => ({
    user_id: toInt(row.user_id, "user_id"),
    username: row.username,
    status: row.status,
    roles: stringArray(row.roles),
    is_superadmin: row.is_superadmin === true,
    last_activity_at: row.last_activity_at,
    failed_login_count: toInt(row.failed_login_count, "failed_login_count"),
    last_failed_login_at: row.last_failed_login_at,
    exceptional_module_keys: stringArray(row.exceptional_module_keys),
    inactive: row.inactive === true,
  }));
}

export async function repoInsertReviewItem(
  tx: DbQueryer,
  params: {
    review_id: string;
    candidate: AccessReviewCandidate;
    risk_reasons: AccessReviewRiskReason[];
    risk_level: AccessReviewRiskLevel;
  }
): Promise<void> {
  const candidate = params.candidate;
  await tx.query(
    `INSERT INTO public.app_access_review_items (
       review_id, user_id, snapshot_username, snapshot_status, snapshot_roles,
       is_superadmin, last_activity_at, failed_login_count, last_failed_login_at,
       exceptional_module_keys, risk_reasons, risk_level
     ) VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6,$7::timestamptz,$8,$9::timestamptz,$10::jsonb,$11::jsonb,$12)`,
    [
      params.review_id,
      candidate.user_id,
      candidate.username,
      candidate.status,
      JSON.stringify(candidate.roles),
      candidate.is_superadmin,
      candidate.last_activity_at,
      candidate.failed_login_count,
      candidate.last_failed_login_at,
      JSON.stringify(candidate.exceptional_module_keys),
      JSON.stringify(params.risk_reasons),
      params.risk_level,
    ]
  );
}

export async function repoGetReview(reviewId: string, tx?: DbQueryer): Promise<AccessReview | null> {
  const q = tx ?? pool;
  const headerRes = await q.query<HeaderRow>(
    `SELECT ${HEADER_SELECT} FROM public.app_access_reviews WHERE id = $1::uuid`,
    [reviewId]
  );
  const header = headerRes.rows[0];
  if (!header) return null;
  const itemRes = await q.query<ItemRow>(
    `SELECT ${ITEM_SELECT}
     FROM public.app_access_review_items
     WHERE review_id = $1::uuid
     ORDER BY
       CASE risk_level WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
       snapshot_username,
       user_id`,
    [reviewId]
  );
  const items = itemRes.rows.map(mapItem);
  return {
    ...mapHeader(header),
    items,
    summary: {
      total: items.length,
      pending: items.filter((item) => item.decision === null).length,
      high_risk: items.filter((item) => item.risk_level === "HIGH").length,
      medium_risk: items.filter((item) => item.risk_level === "MEDIUM").length,
      privileged: items.filter((item) => item.risk_reasons.includes("PRIVILEGED")).length,
      inactive: items.filter((item) => item.risk_reasons.includes("INACTIVE")).length,
      failed_login_bursts: items.filter((item) => item.risk_reasons.includes("FAILED_LOGIN_BURST")).length,
      exceptional_access: items.filter((item) => item.risk_reasons.includes("EXCEPTIONAL_ACCESS")).length,
    },
  };
}

export async function repoListReviews(limit: number): Promise<AccessReviewHeader[]> {
  const { rows } = await pool.query<HeaderRow>(
    `SELECT ${HEADER_SELECT}
     FROM public.app_access_reviews
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map(mapHeader);
}

export async function repoGetReviewItemForUpdate(
  tx: DbQueryer,
  reviewId: string,
  userId: number
): Promise<(ItemRow & { decision_idempotency_key: string | null; decision_request_hash: string | null }) | null> {
  const { rows } = await tx.query<ItemRow & { decision_idempotency_key: string | null; decision_request_hash: string | null }>(
    `SELECT ${ITEM_SELECT}, decision_idempotency_key, decision_request_hash
     FROM public.app_access_review_items
     WHERE review_id = $1::uuid AND user_id = $2
     FOR UPDATE`,
    [reviewId, userId]
  );
  return rows[0] ?? null;
}

export async function repoRecordReviewDecision(
  tx: DbQueryer,
  params: {
    review_id: string;
    user_id: number;
    decision: AccessReviewDecision;
    rationale: string | null;
    decided_by: number;
    idempotency_key: string;
    request_hash: string;
  }
): Promise<void> {
  await tx.query(
    `UPDATE public.app_access_review_items
     SET decision = $3,
         decision_rationale = $4,
         decided_by = $5,
         decided_at = now(),
         decision_idempotency_key = $6,
         decision_request_hash = $7
     WHERE review_id = $1::uuid AND user_id = $2 AND decision IS NULL`,
    [
      params.review_id,
      params.user_id,
      params.decision,
      params.rationale,
      params.decided_by,
      params.idempotency_key,
      params.request_hash,
    ]
  );
}

export async function repoGetReviewForUpdate(tx: DbQueryer, reviewId: string): Promise<HeaderRow | null> {
  const { rows } = await tx.query<HeaderRow>(
    `SELECT ${HEADER_SELECT} FROM public.app_access_reviews WHERE id = $1::uuid FOR UPDATE`,
    [reviewId]
  );
  return rows[0] ?? null;
}

export async function repoCountPendingReviewItems(tx: DbQueryer, reviewId: string): Promise<number> {
  const { rows } = await tx.query<{ pending: number | string }>(
    `SELECT count(*)::int AS pending
     FROM public.app_access_review_items
     WHERE review_id = $1::uuid AND decision IS NULL`,
    [reviewId]
  );
  return toInt(rows[0]?.pending ?? 0, "pending");
}

export async function repoCloseReview(
  tx: DbQueryer,
  params: { review_id: string; closed_by: number }
): Promise<void> {
  await tx.query(
    `UPDATE public.app_access_reviews
     SET status = 'CLOSED', closed_by = $2, closed_at = now()
     WHERE id = $1::uuid AND status = 'OPEN'`,
    [params.review_id, params.closed_by]
  );
}
