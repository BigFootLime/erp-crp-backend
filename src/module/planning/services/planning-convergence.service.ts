import { effectiveRoleParts } from "../../auth/domain/roles";
import {
  PLANNING_RETIREMENT_DECISION,
  PLANNING_USAGE_RETENTION_DAYS,
  type PlanningConvergenceConfig,
  type PlanningRoleBucket,
  type PlanningUsageInput,
} from "../types/planning-convergence.types";
import {
  repoIncrementPlanningUsage,
  repoListPlanningUsageMetrics,
  repoResolvePlanningConvergenceFlags,
} from "../repository/planning-convergence.repository";

function normalizeRole(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s_-]+/g, "");
}

/** Analytics grouping only. Authorization remains in planning-rbac.ts. */
export function resolvePlanningRoleBucket(role: string | null | undefined): PlanningRoleBucket {
  const parts = new Set(effectiveRoleParts(role).map(normalizeRole));
  const hasAny = (...roles: string[]) => roles.some((candidate) => parts.has(candidate));

  if (hasAny("operateuratelier", "responsableatelier", "chefatelier", "atelier")) return "atelier";
  if (hasAny("responsableprogrammation", "planification", "planning")) return "planification";
  if (hasAny("responsableproduction", "production")) return "production";
  if (hasAny("secretariat", "secretaire")) return "secretariat";
  if (hasAny("admin", "administrateur", "administrateursystemeetreseau", "directeur")) return "direction";
  return "other";
}

function isPlanningLegacyDashboardRetired(params: {
  decision: "go" | "no_go";
  flag_enabled: boolean;
}): boolean {
  return params.decision === "go" && params.flag_enabled;
}

export async function svcGetPlanningConvergence(userId: number): Promise<PlanningConvergenceConfig> {
  const flags = await repoResolvePlanningConvergenceFlags(userId);
  const legacyDashboardRetired = isPlanningLegacyDashboardRetired({
    decision: PLANNING_RETIREMENT_DECISION,
    flag_enabled: flags.legacy_retirement_enabled,
  });

  return {
    schema_version: 1,
    canonical_route: "/production/planning",
    rollback_surface: "legacy_dashboard",
    retirement_decision: PLANNING_RETIREMENT_DECISION,
    legacy_dashboard_retirement_enabled: flags.legacy_retirement_enabled,
    legacy_dashboard_retired: legacyDashboardRetired,
    telemetry: {
      enabled: flags.telemetry_enabled,
      collection: "daily_aggregate",
      retention_days: PLANNING_USAGE_RETENTION_DAYS,
      identifiers_collected: false,
    },
  };
}

export async function svcRecordPlanningUsage(params: {
  user_id: number;
  effective_role: string | null | undefined;
  input: PlanningUsageInput;
}): Promise<{ recorded: boolean }> {
  const flags = await repoResolvePlanningConvergenceFlags(params.user_id);
  if (!flags.telemetry_enabled) return { recorded: false };

  await repoIncrementPlanningUsage({
    input: params.input,
    role_bucket: resolvePlanningRoleBucket(params.effective_role),
  });
  return { recorded: true };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function svcGetPlanningUsageMetrics(params: { from?: string; to?: string }) {
  const to = params.to ?? isoDate(new Date());
  const fromDate = new Date(`${to}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 27);
  const from = params.from ?? isoDate(fromDate);
  const rows = await repoListPlanningUsageMetrics({ from, to });

  return {
    from,
    to,
    rows,
    privacy: {
      collection: "daily_aggregate" as const,
      identifiers_collected: false as const,
      retention_days: PLANNING_USAGE_RETENTION_DAYS,
    },
  };
}
