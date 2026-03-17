import type { PoolClient } from "pg";

import pool from "../../../config/database";
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
  payload: unknown;
  created_at: string;
  read_at: string | null;
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
    payload: toPayload(row.payload),
    created_at: row.created_at,
    read_at: row.read_at,
  };
}

export async function repoListAppNotifications(params: {
  user_id: number;
  unread_only?: boolean;
  limit?: number;
}): Promise<AppNotificationsList> {
  const where = ["user_id = $1::int"];
  const values: unknown[] = [params.user_id];
  if (params.unread_only) where.push("read_at IS NULL");
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const limit = Math.max(1, Math.min(100, Math.trunc(params.limit ?? 20)));

  const totalRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.app_notifications ${whereSql}`,
    values
  );
  const unreadRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.app_notifications WHERE user_id = $1::int AND read_at IS NULL`,
    [params.user_id]
  );

  const itemsRes = await pool.query<NotificationRow>(
    `
      SELECT
        id::text AS id,
        user_id::int AS user_id,
        kind,
        title,
        message,
        severity::text AS severity,
        action_url,
        action_label,
        payload,
        created_at::text AS created_at,
        read_at::text AS read_at
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
      RETURNING
        id::text AS id,
        user_id::int AS user_id,
        kind,
        title,
        message,
        severity::text AS severity,
        action_url,
        action_label,
        payload,
        created_at::text AS created_at,
        read_at::text AS read_at
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
          payload,
          dedupe_key
        )
        VALUES ($1::int, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        RETURNING
          id::text AS id,
          user_id::int AS user_id,
          kind,
          title,
          message,
          severity::text AS severity,
          action_url,
          action_label,
          payload,
          created_at::text AS created_at,
          read_at::text AS read_at
      `,
      [
        userId,
        params.kind,
        params.title,
        params.message,
        severity,
        params.action_url ?? null,
        params.action_label ?? null,
        JSON.stringify(params.payload ?? {}),
        dedupeKey,
      ]
    );

    const row = ins.rows[0] ?? null;
    if (row) created.push(mapNotification(row));
  }

  return created;
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
