import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import type { AppNotification, AppNotificationSeverity, AppNotificationsList } from "../types/notifications.types";

type DbQueryer = Pick<PoolClient, "query">;

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPayload(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

type NotificationRow = {
  id: string;
  user_id: number;
  kind: string;
  title: string;
  message: string;
  severity: AppNotificationSeverity;
  action_url: string | null;
  action_label: string | null;
  action_key: string | null;
  entity_type: string | null;
  entity_id: string | null;
  module_key: string | null;
  payload: unknown;
  created_at: string;
  read_at: string | null;
  expires_at: string | null;
  muted_until: string | null;
  escalated_at: string | null;
  escalation_level: number;
};

function mapNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    user_id: toInt(row.user_id, "app_notifications.user_id"),
    kind: row.kind,
    title: row.title,
    message: row.message,
    severity: row.severity,
    action_url: row.action_url,
    action_label: row.action_label,
    action_key: row.action_key ?? null,
    action_available: row.action_url !== null,
    action_unavailable_reason: null,
    entity_type: row.entity_type ?? null,
    entity_id: row.entity_id ?? null,
    module_key: row.module_key ?? null,
    payload: toPayload(row.payload),
    created_at: row.created_at,
    read_at: row.read_at,
    expires_at: row.expires_at ?? null,
    muted_until: row.muted_until ?? null,
    escalated_at: row.escalated_at ?? null,
    escalation_level: toInt(row.escalation_level ?? 0, "app_notifications.escalation_level"),
    state:
      row.expires_at && new Date(row.expires_at).getTime() <= Date.now()
        ? "EXPIRED"
        : row.muted_until && new Date(row.muted_until).getTime() > Date.now()
          ? "MUTED"
          : row.read_at
            ? "READ"
            : "ACTIVE",
  };
}

const NOTIFICATION_SELECT = `
  id::text AS id,
  user_id::int AS user_id,
  kind,
  title,
  message,
  severity::text AS severity,
  action_url,
  action_label,
  action_key,
  entity_type,
  entity_id,
  module_key,
  payload,
  created_at::text AS created_at,
  read_at::text AS read_at,
  expires_at::text AS expires_at,
  muted_until::text AS muted_until,
  escalated_at::text AS escalated_at,
  escalation_level::int AS escalation_level
`;

export async function withNotificationTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, fn);
}

export async function repoListAppNotifications(params: {
  user_id: number;
  unread_only?: boolean;
  include_muted?: boolean;
  include_expired?: boolean;
  limit?: number;
}): Promise<AppNotificationsList> {
  const where = ["user_id = $1::int"];
  const values: unknown[] = [params.user_id];
  if (params.unread_only) where.push("read_at IS NULL");
  if (!params.include_muted) where.push("(muted_until IS NULL OR muted_until <= now())");
  if (!params.include_expired) where.push("(expires_at IS NULL OR expires_at > now())");
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const limit = Math.max(1, Math.min(100, Math.trunc(params.limit ?? 20)));

  const totalRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.app_notifications ${whereSql}`,
    values
  );
  const unreadRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.app_notifications
     WHERE user_id = $1::int AND read_at IS NULL
       AND (muted_until IS NULL OR muted_until <= now())
       AND (expires_at IS NULL OR expires_at > now())`,
    [params.user_id]
  );
  const stateCounts = await pool.query<{ muted_total: number; expired_total: number }>(
    `SELECT
       count(*) FILTER (WHERE muted_until > now() AND (expires_at IS NULL OR expires_at > now()))::int AS muted_total,
       count(*) FILTER (WHERE expires_at <= now())::int AS expired_total
     FROM public.app_notifications WHERE user_id = $1::int`,
    [params.user_id]
  );

  const itemsRes = await pool.query<NotificationRow>(
    `
      SELECT ${NOTIFICATION_SELECT}
      FROM public.app_notifications
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [...values, limit]
  );

  return {
    items: itemsRes.rows.map(mapNotification),
    total: totalRes.rows[0]?.total ?? 0,
    unread_total: unreadRes.rows[0]?.total ?? 0,
    muted_total: stateCounts.rows[0]?.muted_total ?? 0,
    expired_total: stateCounts.rows[0]?.expired_total ?? 0,
  };
}

export async function repoMarkAppNotificationRead(params: {
  user_id: number;
  notification_id: string;
  read_by: number;
}): Promise<AppNotification | null> {
  const res = await pool.query<NotificationRow>(
    `
      UPDATE public.app_notifications
      SET
        read_at = COALESCE(read_at, now()),
        read_by = COALESCE(read_by, $3::int)
      WHERE id = $1::uuid
        AND user_id = $2::int
      RETURNING ${NOTIFICATION_SELECT}
    `,
    [params.notification_id, params.user_id, params.read_by]
  );

  const row = res.rows[0] ?? null;
  return row ? mapNotification(row) : null;
}

export async function repoMarkAllAppNotificationsRead(params: {
  user_id: number;
  read_by: number;
}): Promise<{ updated: number }> {
  const res = await pool.query<{ updated: number }>(
    `
      WITH updated_rows AS (
        UPDATE public.app_notifications
        SET
          read_at = COALESCE(read_at, now()),
          read_by = COALESCE(read_by, $2::int)
        WHERE user_id = $1::int
          AND read_at IS NULL
        RETURNING 1
      )
      SELECT COUNT(*)::int AS updated
      FROM updated_rows
    `,
    [params.user_id, params.read_by]
  );

  return { updated: res.rows[0]?.updated ?? 0 };
}

export async function repoCreateAppNotifications(params: {
  tx: DbQueryer;
  user_ids: number[];
  kind: string;
  title: string;
  message: string;
  severity?: AppNotificationSeverity;
  action_url?: string | null;
  action_label?: string | null;
  action_key?: string | null;
  entity_type?: string | null;
  entity_id?: string | number | null;
  module_key?: string | null;
  expires_at?: string | null;
  payload?: Record<string, unknown> | null;
  dedupe_key?: string | null;
}): Promise<AppNotification[]> {
  const seen = new Set<number>();
  const userIds = params.user_ids.filter((userId) => {
    if (!Number.isInteger(userId) || userId <= 0) return false;
    if (seen.has(userId)) return false;
    seen.add(userId);
    return true;
  });
  if (!userIds.length) return [];

  const severity = params.severity ?? "info";
  const dedupeKey = typeof params.dedupe_key === "string" && params.dedupe_key.trim() ? params.dedupe_key.trim() : null;
  const actionUrl = params.action_url ?? null;
  if (actionUrl && (!actionUrl.startsWith("/") || actionUrl.startsWith("//") || actionUrl.includes("\\"))) {
    throw new Error("Notification action_url must be an internal relative URL");
  }
  const hasEntityType = Boolean(params.entity_type);
  const hasEntityId = params.entity_id !== undefined && params.entity_id !== null && String(params.entity_id).trim() !== "";
  if (hasEntityType !== hasEntityId) throw new Error("Notification entity_type and entity_id must be provided together");
  const created: AppNotification[] = [];

  for (const userId of userIds) {
    if (dedupeKey) {
      const exists = await params.tx.query<{ id: string }>(
        `
          SELECT id::text AS id
          FROM public.app_notifications
          WHERE user_id = $1::int
            AND dedupe_key = $2
          LIMIT 1
        `,
        [userId, dedupeKey]
      );
      if (exists.rows[0]?.id) continue;
    }

    const ins = await params.tx.query<NotificationRow>(
      `
        INSERT INTO public.app_notifications (
          user_id,
          kind,
          title,
          message,
          severity,
          action_url,
          action_label,
          action_key,
          entity_type,
          entity_id,
          module_key,
          expires_at,
          payload,
          dedupe_key
        )
        VALUES ($1::int, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::jsonb, $14)
        RETURNING ${NOTIFICATION_SELECT}
      `,
      [
        userId,
        params.kind,
        params.title,
        params.message,
        severity,
        actionUrl,
        params.action_label ?? null,
        params.action_key ?? null,
        params.entity_type ?? null,
        hasEntityId ? String(params.entity_id) : null,
        params.module_key ?? null,
        params.expires_at ?? null,
        JSON.stringify(params.payload ?? {}),
        dedupeKey,
      ]
    );

    const row = ins.rows[0] ?? null;
    if (row) created.push(mapNotification(row));
  }

  return created;
}

export async function repoGetNotificationForUpdate(
  tx: DbQueryer,
  params: { user_id: number; notification_id: string }
): Promise<AppNotification | null> {
  const { rows } = await tx.query<NotificationRow>(
    `SELECT ${NOTIFICATION_SELECT}
     FROM public.app_notifications
     WHERE id = $1::uuid AND user_id = $2::int
     FOR UPDATE`,
    [params.notification_id, params.user_id]
  );
  return rows[0] ? mapNotification(rows[0]) : null;
}

export async function repoMuteNotification(
  tx: DbQueryer,
  params: { user_id: number; notification_id: string; muted_until: string }
): Promise<AppNotification | null> {
  const { rows } = await tx.query<NotificationRow>(
    `UPDATE public.app_notifications
     SET muted_until = $3::timestamptz, state_updated_at = now(), state_updated_by = $2
     WHERE id = $1::uuid AND user_id = $2::int
     RETURNING ${NOTIFICATION_SELECT}`,
    [params.notification_id, params.user_id, params.muted_until]
  );
  return rows[0] ? mapNotification(rows[0]) : null;
}

export async function repoEscalateNotification(
  tx: DbQueryer,
  params: { user_id: number; notification_id: string; level: number }
): Promise<AppNotification | null> {
  const { rows } = await tx.query<NotificationRow>(
    `UPDATE public.app_notifications
     SET escalation_level = GREATEST(escalation_level, $3),
         escalated_at = CASE WHEN escalation_level < $3 THEN now() ELSE escalated_at END,
         state_updated_at = CASE WHEN escalation_level < $3 THEN now() ELSE state_updated_at END,
         state_updated_by = CASE WHEN escalation_level < $3 THEN $2 ELSE state_updated_by END
     WHERE id = $1::uuid AND user_id = $2::int
     RETURNING ${NOTIFICATION_SELECT}`,
    [params.notification_id, params.user_id, params.level]
  );
  return rows[0] ? mapNotification(rows[0]) : null;
}

export async function repoListUsersForCommandePlanningNotification(tx: DbQueryer): Promise<number[]> {
  const res = await tx.query<{ id: number }>(
    `
      SELECT DISTINCT u.id::int AS id
      FROM public.users u
      WHERE COALESCE(NULLIF(lower(trim(u.status)), ''), 'active') NOT IN ('inactive', 'blocked', 'suspended')
        AND (
          lower(COALESCE(u.role, '')) LIKE '%secr%'
          OR lower(COALESCE(u.role, '')) LIKE '%secret%'
          OR lower(COALESCE(u.role, '')) LIKE '%compt%'
          OR lower(COALESCE(u.role, '')) LIKE '%admin%'
          OR lower(COALESCE(u.role, '')) LIKE '%administr%'
          OR lower(COALESCE(u.role, '')) LIKE '%direction%'
          OR lower(COALESCE(u.username, '')) LIKE '%ghislaine%'
          OR lower(COALESCE(u.email, '')) LIKE '%ghislaine%'
          OR lower(COALESCE(u.name, '')) LIKE '%ghislaine%'
          OR lower(COALESCE(u.surname, '')) LIKE '%ghislaine%'
        )
      ORDER BY u.id ASC
    `
  );

  return res.rows.map((row) => row.id).filter((id) => Number.isInteger(id) && id > 0);
}
