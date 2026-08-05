import type { PoolClient } from "pg";

import pool from "../../../config/database";
import {
  PLANNING_LEGACY_DASHBOARD_RETIREMENT_FLAG,
  PLANNING_USAGE_METRICS_FLAG,
  type PlanningRoleBucket,
  type PlanningUsageInput,
  type PlanningUsageMetricRow,
} from "../types/planning-convergence.types";

type DbQueryer = Pick<PoolClient, "query">;
type FlagRow = { key: string; enabled: boolean | null };

function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "42P01";
}

/** Missing tables, flags and non-positive values all keep retirement and telemetry OFF. */
export async function repoResolvePlanningConvergenceFlags(
  userId: number,
  q: DbQueryer = pool
): Promise<{ legacy_retirement_enabled: boolean; telemetry_enabled: boolean }> {
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
      [[PLANNING_LEGACY_DASHBOARD_RETIREMENT_FLAG, PLANNING_USAGE_METRICS_FLAG], userId]
    );
    const byKey = new Map(flags.rows.map((row) => [row.key, row.enabled]));
    const infrastructure = await q.query<{ usage_table_ready: boolean }>(
      "SELECT to_regclass('public.planning_surface_usage_daily') IS NOT NULL AS usage_table_ready"
    );

    return {
      legacy_retirement_enabled: byKey.get(PLANNING_LEGACY_DASHBOARD_RETIREMENT_FLAG) === true,
      telemetry_enabled:
        byKey.get(PLANNING_USAGE_METRICS_FLAG) === true &&
        infrastructure.rows[0]?.usage_table_ready === true,
    };
  } catch (error) {
    if (isUndefinedTable(error)) {
      return { legacy_retirement_enabled: false, telemetry_enabled: false };
    }
    throw error;
  }
}

/** Daily counter only; no user/session/network identifier or free text reaches storage. */
export async function repoIncrementPlanningUsage(
  params: { input: PlanningUsageInput; role_bucket: PlanningRoleBucket },
  q: DbQueryer = pool
): Promise<void> {
  await q.query(
    `
      INSERT INTO public.planning_surface_usage_daily (
        usage_date,
        surface,
        event_type,
        browser_family,
        role_bucket,
        event_count,
        first_seen_at,
        last_seen_at
      )
      VALUES (CURRENT_DATE, $1, $2, $3, $4, 1, now(), now())
      ON CONFLICT (usage_date, surface, event_type, browser_family, role_bucket)
      DO UPDATE SET
        event_count = public.planning_surface_usage_daily.event_count + 1,
        last_seen_at = now()
    `,
    [
      params.input.surface,
      params.input.event_type,
      params.input.browser_family,
      params.role_bucket,
    ]
  );
}

type PlanningUsageMetricDbRow = Omit<PlanningUsageMetricRow, "event_count"> & {
  event_count: string | number;
};

export async function repoListPlanningUsageMetrics(
  params: { from: string; to: string },
  q: DbQueryer = pool
): Promise<PlanningUsageMetricRow[]> {
  const result = await q.query<PlanningUsageMetricDbRow>(
    `
      SELECT
        usage_date::text,
        surface,
        event_type,
        browser_family,
        role_bucket,
        event_count::text
      FROM public.planning_surface_usage_daily
      WHERE usage_date BETWEEN $1::date AND $2::date
      ORDER BY usage_date, role_bucket, browser_family, surface, event_type
    `,
    [params.from, params.to]
  );

  return result.rows.map((row) => ({ ...row, event_count: Number(row.event_count) }));
}
