export type PlanningReliability = "VERIFIED" | "PARTIAL" | "UNAVAILABLE";

export type PlanningMetric = {
  value: number | null;
  unit: string;
  numerator: number | null;
  denominator: number | null;
  definition: string;
  source: string[];
  freshness_at: string | null;
  reliability: PlanningReliability;
  missing: string[];
};

export type PlanningStopCause = {
  code: string;
  label: string;
  duration_minutes: number;
  occurrences: number;
  reason_missing_count: number;
  source: "production_pointages";
};

export type PlanningCapacityOf = {
  event_id: string;
  of_id: number | null;
  of_numero: string | null;
  operation_id: string | null;
  phase: number | null;
  designation: string | null;
  planned_minutes: number;
  start_ts: string;
  end_ts: string;
  status: string;
};

export type PlanningCapacityCell = {
  machine_id: string;
  machine_code: string;
  machine_name: string;
  week_start: string;
  available_minutes: number | null;
  unavailable_minutes: number;
  planned_minutes: number;
  actual_minutes: number;
  utilization_pct: number | null;
  state: "AVAILABLE" | "LOADED" | "OVERLOADED" | "BOTTLENECK" | "UNAVAILABLE";
  reliability: PlanningReliability;
  missing: string[];
  drilldown: PlanningCapacityOf[];
};

export type PlanningConflict = {
  id: string;
  code:
    | "SCHEDULE_OVERLAP"
    | "RESOURCE_UNAVAILABLE"
    | "ACTUAL_RESOURCE_MISMATCH"
    | "LONG_RUNNING_EXECUTION"
    | "MISSING_PLANNED_TIME";
  severity: "INFO" | "WARNING" | "CRITICAL";
  explanation: string;
  next_action: string;
  machine_id: string | null;
  machine_code: string | null;
  event_ids: string[];
  of_ids: number[];
};

export type PlanningAction = {
  id: string;
  priority: "P0" | "P1" | "P2";
  title: string;
  explanation: string;
  owner_role: "PLANNER" | "SUPERVISOR" | "OPERATOR";
  due_at: string | null;
  action_path: string;
  machine_id: string | null;
  of_id: number | null;
  operation_id: string | null;
};

export type PlanningPreferences = {
  timezone: string;
  horizon_weeks: number;
  view_mode: "DAY" | "WEEK" | "MONTH" | "YEAR";
  show_weekends: boolean;
  machine_ids: string[];
  status_colors: Record<string, string>;
  client_color_overrides: Record<string, string>;
  updated_at: string | null;
};

export type PlanningExecutionIntelligence = {
  metadata: {
    generated_at: string;
    period: { from: string; to: string; timezone: string };
    definition_version: "SOL-21.v1";
    sources: string[];
    freshness_at: string | null;
    reliability: PlanningReliability;
    warnings: string[];
  };
  capabilities: {
    read_capacity: boolean;
    manage_schedule: boolean;
    manage_preferences: boolean;
    supervise_execution: boolean;
  };
  kpis: {
    schedule_adherence: PlanningMetric;
    throughput: PlanningMetric;
    wip: PlanningMetric;
    aged_wip: PlanningMetric;
    scrap_rate: PlanningMetric;
    planned_time: PlanningMetric;
    actual_time: PlanningMetric;
  };
  capacity: PlanningCapacityCell[];
  stop_causes: PlanningStopCause[];
  conflicts: PlanningConflict[];
  action_queue: PlanningAction[];
};
