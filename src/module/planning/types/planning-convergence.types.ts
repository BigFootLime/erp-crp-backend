export const PLANNING_SURFACES = ["premium_route", "legacy_dashboard"] as const;
export type PlanningSurface = (typeof PLANNING_SURFACES)[number];

export const PLANNING_USAGE_EVENTS = ["view", "open_premium"] as const;
export type PlanningUsageEvent = (typeof PLANNING_USAGE_EVENTS)[number];

export const PLANNING_BROWSER_FAMILIES = ["chromium", "firefox", "webkit", "other"] as const;
export type PlanningBrowserFamily = (typeof PLANNING_BROWSER_FAMILIES)[number];

export const PLANNING_ROLE_BUCKETS = [
  "direction",
  "planification",
  "production",
  "atelier",
  "secretariat",
  "other",
] as const;
export type PlanningRoleBucket = (typeof PLANNING_ROLE_BUCKETS)[number];

export const PLANNING_USAGE_RETENTION_DAYS = 90;
export const PLANNING_LEGACY_DASHBOARD_RETIREMENT_FLAG = "PLANNING_LEGACY_DASHBOARD_RETIREMENT";
export const PLANNING_USAGE_METRICS_FLAG = "PLANNING_USAGE_METRICS";

/**
 * REMOVE-CERP-0004 is deliberately NO-GO. A later parity PR must change this
 * decision in code as well as activating the database flag: either key alone
 * is insufficient to hide the rollback surface.
 */
export const PLANNING_RETIREMENT_DECISION = "no_go" as const;
export type PlanningRetirementDecision = "go" | "no_go";

export type PlanningConvergenceConfig = {
  schema_version: 1;
  canonical_route: "/production/planning";
  rollback_surface: "legacy_dashboard";
  retirement_decision: PlanningRetirementDecision;
  legacy_dashboard_retirement_enabled: boolean;
  legacy_dashboard_retired: boolean;
  telemetry: {
    enabled: boolean;
    collection: "daily_aggregate";
    retention_days: typeof PLANNING_USAGE_RETENTION_DAYS;
    identifiers_collected: false;
  };
};

export type PlanningUsageInput = {
  surface: PlanningSurface;
  event_type: PlanningUsageEvent;
  browser_family: PlanningBrowserFamily;
};

export type PlanningUsageMetricRow = {
  usage_date: string;
  surface: PlanningSurface;
  event_type: PlanningUsageEvent;
  browser_family: PlanningBrowserFamily;
  role_bucket: PlanningRoleBucket;
  event_count: number;
};
