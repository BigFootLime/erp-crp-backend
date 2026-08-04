export const DASHBOARD_EXPERIENCES = ["ariane", "v2", "legacy"] as const;
export type DashboardExperience = (typeof DASHBOARD_EXPERIENCES)[number];

export const DASHBOARD_USAGE_EVENTS = ["view", "switch", "deep_link", "preference_migrated", "fallback"] as const;
export type DashboardUsageEvent = (typeof DASHBOARD_USAGE_EVENTS)[number];

export const DASHBOARD_SELECTION_SOURCES = ["default", "preference", "query", "switch", "rollback", "migration"] as const;
export type DashboardSelectionSource = (typeof DASHBOARD_SELECTION_SOURCES)[number];

export const DASHBOARD_ROLE_BUCKETS = ["direction", "production", "achats", "qualite", "operateur"] as const;
export type DashboardRoleBucket = (typeof DASHBOARD_ROLE_BUCKETS)[number];

export const DASHBOARD_USAGE_RETENTION_DAYS = 90;
export const DASHBOARD_ARIANE_DEFAULT_FLAG = "DASHBOARD_ARIANE_DEFAULT";
export const DASHBOARD_USAGE_METRICS_FLAG = "DASHBOARD_USAGE_METRICS";

export type DashboardGovernanceConfig = {
  schema_version: 1;
  default_experience: "ariane" | "v2";
  rollback_experience: "v2";
  ariane_default_enabled: boolean;
  deep_links_preserved: true;
  telemetry: {
    enabled: boolean;
    collection: "daily_aggregate";
    retention_days: typeof DASHBOARD_USAGE_RETENTION_DAYS;
    identifiers_collected: false;
  };
};

export type DashboardUsageInput = {
  experience: DashboardExperience;
  event_type: DashboardUsageEvent;
  selection_source: DashboardSelectionSource;
  previous_experience?: DashboardExperience;
};

export type DashboardUsageMetricRow = {
  usage_date: string;
  experience: DashboardExperience;
  event_type: DashboardUsageEvent;
  selection_source: DashboardSelectionSource;
  previous_experience: DashboardExperience | null;
  role_bucket: DashboardRoleBucket;
  event_count: number;
};
