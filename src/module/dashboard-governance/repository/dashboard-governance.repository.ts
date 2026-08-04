import type { PoolClient } from "pg";

import pool from "../../../config/database";
import {
  DASHBOARD_ARIANE_DEFAULT_FLAG,
  DASHBOARD_USAGE_METRICS_FLAG,
  type DashboardRoleBucket,
  type DashboardUsageInput,
  type DashboardUsageMetricRow,
} from "../types/dashboard-governance.types";

type DbQueryer = Pick<PoolClient, "query">;

type FlagRow = { key: string; enabled: boolean | null };

function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "42P01";
}

/**
 * Résout les deux kill-switches de convergence. L'absence de table, de flag ou
 * de valeur globale positive reste fail-closed : V2 et collecte OFF.
 */
export async function repoResolveDashboardFlags(
  userId: number,
  q: DbQueryer = pool
): Promise<{ ariane_default_enabled: boolean; telemetry_enabled: boolean }> {
  try {
    const flags = await q.query<FlagRow>(
      `
        WITH requested(key) AS (
          SELECT unnest($1::text[])
        )
        SELECT
          requested.key,
          (ff.enabled IS TRUE AND COALESCE(ffu.enabled, TRUE) IS TRUE) AS enabled
        FROM requested
        LEFT JOIN public.app_feature_flags ff ON ff.key = requested.key
        LEFT JOIN public.app_feature_flag_users ffu
          ON ffu.feature_flag_id = ff.id AND ffu.user_id = $2::int
      `,
      [[DASHBOARD_ARIANE_DEFAULT_FLAG, DASHBOARD_USAGE_METRICS_FLAG], userId]
    );
    const byKey = new Map(flags.rows.map((row) => [row.key, row.enabled]));
    const infrastructure = await q.query<{ usage_table_ready: boolean }>(
      "SELECT to_regclass('public.dashboard_usage_daily') IS NOT NULL AS usage_table_ready"
    );

    return {
      ariane_default_enabled: byKey.get(DASHBOARD_ARIANE_DEFAULT_FLAG) === true,
      telemetry_enabled:
        byKey.get(DASHBOARD_USAGE_METRICS_FLAG) === true &&
        infrastructure.rows[0]?.usage_table_ready === true,
    };
  } catch (error) {
    if (isUndefinedTable(error)) {
      return { ariane_default_enabled: false, telemetry_enabled: false };
    }
    throw error;
  }
}

/**
 * Compteur quotidien uniquement : aucun user_id, IP, URL, user-agent ou texte
 * libre n'est écrit. Le rôle est réduit à une famille métier avant ce niveau.
 */
export async function repoIncrementDashboardUsage(
  params: { input: DashboardUsageInput; role_bucket: DashboardRoleBucket },
  q: DbQueryer = pool
): Promise<void> {
  await q.query(
    `
      INSERT INTO public.dashboard_usage_daily (
        usage_date,
        experience,
        event_type,
        selection_source,
        previous_experience,
        role_bucket,
        event_count,
        first_seen_at,
        last_seen_at
      )
      VALUES (
        CURRENT_DATE,
        $1,
        $2,
        $3,
        $4,
        $5,
        1,
        now(),
        now()
      )
      ON CONFLICT (
        usage_date,
        experience,
        event_type,
        selection_source,
        previous_experience,
        role_bucket
      )
      DO UPDATE SET
        event_count = public.dashboard_usage_daily.event_count + 1,
        last_seen_at = now()
    `,
    [
      params.input.experience,
      params.input.event_type,
      params.input.selection_source,
      params.input.previous_experience ?? "none",
      params.role_bucket,
    ]
  );
}

type UsageMetricDbRow = Omit<DashboardUsageMetricRow, "previous_experience" | "event_count"> & {
  previous_experience: string;
  event_count: string | number;
};

export async function repoListDashboardUsageMetrics(
  params: { from: string; to: string },
  q: DbQueryer = pool
): Promise<DashboardUsageMetricRow[]> {
  const result = await q.query<UsageMetricDbRow>(
    `
      SELECT
        usage_date::text,
        experience,
        event_type,
        selection_source,
        previous_experience,
        role_bucket,
        event_count::text
      FROM public.dashboard_usage_daily
      WHERE usage_date BETWEEN $1::date AND $2::date
      ORDER BY usage_date, role_bucket, experience, event_type, selection_source
    `,
    [params.from, params.to]
  );

  return result.rows.map((row) => ({
    ...row,
    previous_experience: row.previous_experience === "none"
      ? null
      : row.previous_experience as DashboardUsageMetricRow["previous_experience"],
    event_count: Number(row.event_count),
  }));
}
