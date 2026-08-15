export type OperationsState = "operational" | "degraded" | "down" | "stale" | "unavailable";

export type OperationsReliability = "MEASURED" | "DERIVED" | "CONFIGURED" | "UNAVAILABLE";

export type OperationsFact = Readonly<{
  key: string;
  label: string;
  value: string | number | boolean | null;
  unit: string;
  period: string;
  source: string;
  observed_at: string;
  reliability: OperationsReliability;
}>;

export type OperationsSignal = Readonly<{
  id: string;
  label: string;
  category: "runtime" | "data" | "documents" | "jobs" | "backups" | "integrations";
  state: OperationsState;
  required: boolean;
  current: string;
  reason_code: string | null;
  affected_scope: string;
  latency_ms: number | null;
  observed_at: string;
  freshness_seconds: number | null;
  last_success_at: string | null;
  last_error_at: string | null;
  source: string;
  reliability: OperationsReliability;
  runbook_url: string;
  logs_url: string | null;
  facts: readonly OperationsFact[];
}>;

export type OperationsAlert = Readonly<{
  name: string;
  severity: "P0" | "P1" | "P2" | "UNKNOWN";
  affected_scope: string;
  observed_at: string;
  source: "prometheus_alerts";
  runbook_url: string | null;
}>;

export type OperationsConsoleSnapshot = Readonly<{
  observed_at: string;
  overall_state: "operational" | "degraded" | "down";
  read_only: true;
  service: Readonly<{
    name: string;
    version: string;
    commit: string | null;
    environment: string;
  }>;
  signals: readonly OperationsSignal[];
  alerts: readonly OperationsAlert[];
  links: Readonly<{
    dashboards: string | null;
    logs: string | null;
  }>;
  limitations: readonly string[];
}>;

export type QueueSnapshot = Readonly<{
  id: "advanced_reminders" | "webhook_delivery" | "electronic_invoicing";
  available: boolean;
  pending: number;
  failures: number;
  oldest_pending_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  latency_ms: number;
  reason_code: string | null;
}>;

export type MigrationLedgerSnapshot = Readonly<{
  registry_exists: boolean;
  rows: readonly Readonly<{ filename: string; sha256: string; applied_at: string }>[];
  latency_ms: number;
}>;
