import type { Pool } from "pg";

import { runtimeMetadata } from "./runtime";

const HTTP_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

type DependencyName = "database" | "ged_storage" | "antivirus" | "realtime";
type DependencyState = Readonly<{ up: boolean; checkedAtMs: number; latencyMs: number }>;
type JobState = Readonly<{
  lastStartedAtMs: number;
  lastSucceededAtMs: number;
  lastFailedAtMs: number;
  failures: number;
  running: boolean;
}>;

const requestTotals = new Map<string, number>();
const requestDurationCounts = new Map<string, number>();
const requestDurationSums = new Map<string, number>();
const requestDurationBuckets = new Map<string, number[]>();
const dependencies = new Map<DependencyName, DependencyState>();
const jobs = new Map<string, JobState>();
const documentScanTotals = new Map<string, number>();
const documentScanDurationSums = new Map<string, number>();
let gedQuarantine: Readonly<{
  pending: number;
  clean: number;
  infected: number;
  scanFailed: number;
  oldestAgeSeconds: number;
}> | null = null;
let gedCapacity: Readonly<{
  capacityBytes: number;
  availableBytes: number;
  usedRatio: number;
  inodeTotal: number;
  inodeFree: number;
}> | null = null;

function increment(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labels(values: Record<string, string>): string {
  return `{${Object.entries(values).map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

export function observeHttpRequest(method: string, route: string, status: number, durationMs: number): void {
  const statusClass = `${Math.floor(status / 100)}xx`;
  const key = [method.toUpperCase(), route, statusClass].join("|");
  increment(requestTotals, key);
  increment(requestDurationCounts, key);
  increment(requestDurationSums, key, durationMs / 1_000);
  const buckets = requestDurationBuckets.get(key) ?? HTTP_BUCKETS_SECONDS.map(() => 0);
  const seconds = durationMs / 1_000;
  HTTP_BUCKETS_SECONDS.forEach((upper, index) => {
    if (seconds <= upper) buckets[index] += 1;
  });
  requestDurationBuckets.set(key, buckets);
}

export function setDependencyState(
  name: DependencyName,
  up: boolean,
  latencyMs: number,
  checkedAtMs = Date.now()
): void {
  dependencies.set(name, { up, latencyMs, checkedAtMs });
}

export function setGedCapacity(capacity: {
  capacityBytes: number | null;
  availableBytes: number | null;
  usedRatio: number | null;
  inodeTotal: number | null;
  inodeFree: number | null;
}): void {
  gedCapacity = Object.values(capacity).every((value) => typeof value === "number" && Number.isFinite(value))
    ? capacity as typeof gedCapacity
    : null;
}

export function markJobStarted(name: string, atMs = Date.now()): void {
  const previous = jobs.get(name);
  jobs.set(name, {
    lastStartedAtMs: atMs,
    lastSucceededAtMs: previous?.lastSucceededAtMs ?? 0,
    lastFailedAtMs: previous?.lastFailedAtMs ?? 0,
    failures: previous?.failures ?? 0,
    running: true,
  });
}

export function markJobFinished(name: string, success: boolean, atMs = Date.now()): void {
  const previous = jobs.get(name) ?? {
    lastStartedAtMs: atMs,
    lastSucceededAtMs: 0,
    lastFailedAtMs: 0,
    failures: 0,
    running: true,
  };
  jobs.set(name, {
    ...previous,
    lastSucceededAtMs: success ? atMs : previous.lastSucceededAtMs,
    lastFailedAtMs: success ? previous.lastFailedAtMs : atMs,
    failures: success ? previous.failures : previous.failures + 1,
    running: false,
  });
}

export function observeDocumentScan(outcome: "clean" | "infected" | "unavailable", durationMs: number): void {
  const normalized = outcome === "unavailable" ? "scan_failed" : outcome;
  increment(documentScanTotals, normalized);
  increment(documentScanDurationSums, normalized, Math.max(0, durationMs) / 1_000);
}

export function setGedQuarantineMetrics(input: {
  pending: number;
  clean: number;
  infected: number;
  scanFailed: number;
  oldestAgeSeconds: number;
} | null): void {
  gedQuarantine = input;
}

export function renderPrometheusMetrics(pool?: Pool): string {
  const lines: string[] = [
    "# HELP cerp_build_info CERP service build metadata.",
    "# TYPE cerp_build_info gauge",
    `cerp_build_info${labels(runtimeMetadata)} 1`,
    "# HELP cerp_http_requests_total Completed HTTP requests.",
    "# TYPE cerp_http_requests_total counter",
  ];

  for (const [key, value] of requestTotals) {
    const [method, route, statusClass] = key.split("|");
    lines.push(`cerp_http_requests_total${labels({ method, route, status_class: statusClass })} ${value}`);
  }

  lines.push(
    "# HELP cerp_http_request_duration_seconds HTTP request duration.",
    "# TYPE cerp_http_request_duration_seconds histogram"
  );
  for (const [key, count] of requestDurationCounts) {
    const [method, route, statusClass] = key.split("|");
    const baseLabels = { method, route, status_class: statusClass };
    const buckets = requestDurationBuckets.get(key) ?? [];
    HTTP_BUCKETS_SECONDS.forEach((upper, index) => {
      lines.push(`cerp_http_request_duration_seconds_bucket${labels({ ...baseLabels, le: String(upper) })} ${buckets[index] ?? 0}`);
    });
    lines.push(`cerp_http_request_duration_seconds_bucket${labels({ ...baseLabels, le: "+Inf" })} ${count}`);
    lines.push(`cerp_http_request_duration_seconds_sum${labels(baseLabels)} ${requestDurationSums.get(key) ?? 0}`);
    lines.push(`cerp_http_request_duration_seconds_count${labels(baseLabels)} ${count}`);
  }

  lines.push(
    "# HELP cerp_dependency_up Whether an application dependency is operational.",
    "# TYPE cerp_dependency_up gauge",
    "# HELP cerp_dependency_last_check_timestamp_seconds Last dependency probe time.",
    "# TYPE cerp_dependency_last_check_timestamp_seconds gauge",
    "# HELP cerp_dependency_probe_duration_seconds Dependency probe duration.",
    "# TYPE cerp_dependency_probe_duration_seconds gauge"
  );
  for (const [name, state] of dependencies) {
    const dependencyLabels = labels({ dependency: name });
    lines.push(`cerp_dependency_up${dependencyLabels} ${state.up ? 1 : 0}`);
    lines.push(`cerp_dependency_last_check_timestamp_seconds${dependencyLabels} ${state.checkedAtMs / 1_000}`);
    lines.push(`cerp_dependency_probe_duration_seconds${dependencyLabels} ${state.latencyMs / 1_000}`);
  }

  if (gedCapacity) {
    lines.push(
      "# HELP cerp_ged_storage_bytes GED storage capacity by state.",
      "# TYPE cerp_ged_storage_bytes gauge",
      `cerp_ged_storage_bytes${labels({ state: "capacity" })} ${gedCapacity.capacityBytes}`,
      `cerp_ged_storage_bytes${labels({ state: "available" })} ${gedCapacity.availableBytes}`,
      "# HELP cerp_ged_storage_used_ratio GED storage used ratio from 0 to 1.",
      "# TYPE cerp_ged_storage_used_ratio gauge",
      `cerp_ged_storage_used_ratio ${gedCapacity.usedRatio}`,
      "# HELP cerp_ged_storage_inodes GED storage inodes by state.",
      "# TYPE cerp_ged_storage_inodes gauge",
      `cerp_ged_storage_inodes${labels({ state: "total" })} ${gedCapacity.inodeTotal}`,
      `cerp_ged_storage_inodes${labels({ state: "free" })} ${gedCapacity.inodeFree}`
    );
  }

  lines.push(
    "# HELP cerp_document_scans_total Server-side document antivirus scans by outcome.",
    "# TYPE cerp_document_scans_total counter",
    "# HELP cerp_document_scan_duration_seconds_total Cumulative server-side scan duration by outcome.",
    "# TYPE cerp_document_scan_duration_seconds_total counter"
  );
  for (const [outcome, value] of documentScanTotals) {
    const outcomeLabels = labels({ outcome });
    lines.push(`cerp_document_scans_total${outcomeLabels} ${value}`);
    lines.push(`cerp_document_scan_duration_seconds_total${outcomeLabels} ${documentScanDurationSums.get(outcome) ?? 0}`);
  }

  if (gedQuarantine) {
    lines.push(
      "# HELP cerp_ged_quarantine_items Durable GED quarantine items by scan status.",
      "# TYPE cerp_ged_quarantine_items gauge",
      `cerp_ged_quarantine_items${labels({ scan_status: "pending" })} ${gedQuarantine.pending}`,
      `cerp_ged_quarantine_items${labels({ scan_status: "clean" })} ${gedQuarantine.clean}`,
      `cerp_ged_quarantine_items${labels({ scan_status: "infected" })} ${gedQuarantine.infected}`,
      `cerp_ged_quarantine_items${labels({ scan_status: "scan_failed" })} ${gedQuarantine.scanFailed}`,
      "# HELP cerp_ged_quarantine_oldest_age_seconds Age of the oldest durable quarantine item.",
      "# TYPE cerp_ged_quarantine_oldest_age_seconds gauge",
      `cerp_ged_quarantine_oldest_age_seconds ${gedQuarantine.oldestAgeSeconds}`
    );
  }

  if (pool) {
    lines.push(
      "# HELP cerp_db_pool_connections PostgreSQL pool connections by state.",
      "# TYPE cerp_db_pool_connections gauge",
      `cerp_db_pool_connections${labels({ state: "total" })} ${pool.totalCount}`,
      `cerp_db_pool_connections${labels({ state: "idle" })} ${pool.idleCount}`,
      `cerp_db_pool_connections${labels({ state: "waiting" })} ${pool.waitingCount}`,
      "# HELP cerp_db_pool_max_connections Configured PostgreSQL pool capacity.",
      "# TYPE cerp_db_pool_max_connections gauge",
      `cerp_db_pool_max_connections ${pool.options.max ?? 10}`
    );
  }

  lines.push(
    "# HELP cerp_job_last_success_timestamp_seconds Last successful critical job run.",
    "# TYPE cerp_job_last_success_timestamp_seconds gauge",
    "# HELP cerp_job_last_failure_timestamp_seconds Last failed critical job run.",
    "# TYPE cerp_job_last_failure_timestamp_seconds gauge",
    "# HELP cerp_job_failures_total Failed critical job runs since process start.",
    "# TYPE cerp_job_failures_total counter",
    "# HELP cerp_job_running Whether a critical job is currently running.",
    "# TYPE cerp_job_running gauge"
  );
  for (const [name, state] of jobs) {
    const jobLabels = labels({ job: name });
    lines.push(`cerp_job_last_success_timestamp_seconds${jobLabels} ${state.lastSucceededAtMs / 1_000}`);
    lines.push(`cerp_job_last_failure_timestamp_seconds${jobLabels} ${state.lastFailedAtMs / 1_000}`);
    lines.push(`cerp_job_failures_total${jobLabels} ${state.failures}`);
    lines.push(`cerp_job_running${jobLabels} ${state.running ? 1 : 0}`);
  }

  return `${lines.join("\n")}\n`;
}

export const prometheusContentType = "text/plain; version=0.0.4; charset=utf-8";

export function resetMetricsForTests(): void {
  requestTotals.clear();
  requestDurationCounts.clear();
  requestDurationSums.clear();
  requestDurationBuckets.clear();
  dependencies.clear();
  jobs.clear();
  documentScanTotals.clear();
  documentScanDurationSums.clear();
  gedCapacity = null;
  gedQuarantine = null;
}
