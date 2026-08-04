import {
  DASHBOARD_USAGE_RETENTION_DAYS,
  type DashboardGovernanceConfig,
  type DashboardRoleBucket,
  type DashboardUsageInput,
} from "../types/dashboard-governance.types";
import {
  repoIncrementDashboardUsage,
  repoListDashboardUsageMetrics,
  repoResolveDashboardFlags,
} from "../repository/dashboard-governance.repository";

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/** Famille d'analyse seulement, jamais une décision d'autorisation. */
export function resolveDashboardRoleBucket(role: string | null | undefined): DashboardRoleBucket {
  const parts = String(role ?? "").split("|").map(normalize).filter(Boolean);
  const has = (needle: string) => parts.some((part) => part.includes(needle));

  if (has("operateur") || has("usinage") || has("pointage") || has("mon poste")) return "operateur";
  if (has("qualit") || has("metrolog")) return "qualite";
  if (has("achat") || has("approvision") || has("fournisseur")) return "achats";
  if (has("production") || has("planification") || has("methode") || has("atelier") || has("ordonnancement")) {
    return "production";
  }
  return "direction";
}

export async function svcGetDashboardGovernance(userId: number): Promise<DashboardGovernanceConfig> {
  const flags = await repoResolveDashboardFlags(userId);
  return {
    schema_version: 1,
    default_experience: flags.ariane_default_enabled ? "ariane" : "v2",
    rollback_experience: "v2",
    ariane_default_enabled: flags.ariane_default_enabled,
    deep_links_preserved: true,
    telemetry: {
      enabled: flags.telemetry_enabled,
      collection: "daily_aggregate",
      retention_days: DASHBOARD_USAGE_RETENTION_DAYS,
      identifiers_collected: false,
    },
  };
}

export async function svcRecordDashboardUsage(params: {
  user_id: number;
  effective_role: string | null | undefined;
  input: DashboardUsageInput;
}): Promise<{ recorded: boolean }> {
  const flags = await repoResolveDashboardFlags(params.user_id);
  if (!flags.telemetry_enabled) return { recorded: false };

  await repoIncrementDashboardUsage({
    input: params.input,
    role_bucket: resolveDashboardRoleBucket(params.effective_role),
  });
  return { recorded: true };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function svcGetDashboardUsageMetrics(params: { from?: string; to?: string }) {
  const to = params.to ?? isoDate(new Date());
  const fromDate = new Date(`${to}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 27);
  const from = params.from ?? isoDate(fromDate);
  const rows = await repoListDashboardUsageMetrics({ from, to });

  return {
    from,
    to,
    rows,
    privacy: {
      collection: "daily_aggregate" as const,
      identifiers_collected: false as const,
      retention_days: DASHBOARD_USAGE_RETENTION_DAYS,
    },
  };
}
