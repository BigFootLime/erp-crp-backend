import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import pool from "../../../config/database";
import { svcElectronicInvoiceReadiness } from "../../facturation/electronic-invoicing/electronic-invoice.service";
import { webhookReadiness } from "../../integrations/webhooks/webhook.service";
import { collectReadiness, type ReadinessReport } from "../../../shared/observability/health";
import { getOperationalMetricsSnapshot } from "../../../shared/observability/metrics";
import { runtimeMetadata } from "../../../shared/observability/runtime";
import {
  repoMigrationLedger,
  repoQueueSnapshots,
} from "../repository/operations-console.repository";
import type {
  MigrationLedgerSnapshot,
  OperationsAlert,
  OperationsConsoleSnapshot,
  OperationsFact,
  OperationsReliability,
  OperationsSignal,
  OperationsState,
  QueueSnapshot,
} from "../types/operations-console.types";

export type PatchManifest = Readonly<{
  available: boolean;
  rows: readonly Readonly<{ filename: string; sha256: string }>[];
  reason_code: string | null;
}>;

type PrometheusSample = Readonly<{
  metric: Readonly<Record<string, string>>;
  value: readonly [number, string];
}>;

export type PrometheusSnapshot = Readonly<{
  configured: boolean;
  available: boolean;
  reason_code: string | null;
  latency_ms: number | null;
  observed_at: string;
  metrics: readonly PrometheusSample[];
  alerts: readonly PrometheusSample[];
}>;

export type OperationsConsoleDependencies = Readonly<{
  now: () => Date;
  readiness: () => Promise<ReadinessReport>;
  migrationLedger: () => Promise<MigrationLedgerSnapshot>;
  queueSnapshots: () => Promise<readonly QueueSnapshot[]>;
  patchManifest: () => PatchManifest;
  prometheus: () => Promise<PrometheusSnapshot>;
  runtimeMetrics: typeof getOperationalMetricsSnapshot;
  webhookReadiness: typeof webhookReadiness;
  electronicInvoiceReadiness: typeof svcElectronicInvoiceReadiness;
  environment: NodeJS.ProcessEnv;
}>;

const RUNBOOK_ROOT = "https://github.com/BigFootLime/crp-systems-web/blob/main/docs/runbooks/operations";

const RUNBOOKS = Object.freeze({
  api: `${RUNBOOK_ROOT}/api-unavailable.md`,
  database: `${RUNBOOK_ROOT}/database-degraded.md`,
  documents: `${RUNBOOK_ROOT}/ged-storage-capacity.md`,
  antivirus: `${RUNBOOK_ROOT}/antivirus-quarantine.md`,
  jobs: `${RUNBOOK_ROOT}/job-queue-stuck.md`,
  migrations: `${RUNBOOK_ROOT}/migration-failed.md`,
  backups: `${RUNBOOK_ROOT}/backup-restore.md`,
  integrations: `${RUNBOOK_ROOT}/api-unavailable.md`,
});

const ALERT_RUNBOOKS: Readonly<Record<string, string>> = Object.freeze({
  CERPApiUnavailable: RUNBOOKS.api,
  CERPDatabaseUnavailable: RUNBOOKS.database,
  CERPDatabasePoolSaturated: RUNBOOKS.database,
  CERPGedStorageUnavailable: RUNBOOKS.documents,
  CERPGedStorageCritical: RUNBOOKS.documents,
  CERPAntivirusUnavailable: RUNBOOKS.antivirus,
  CERPDocumentThreatQuarantined: RUNBOOKS.antivirus,
  CERPDocumentScanFailedQuarantined: RUNBOOKS.antivirus,
  CERPDocumentQuarantineBacklog: RUNBOOKS.antivirus,
  CERPDatabaseBackupStale: RUNBOOKS.backups,
  CERPFilesBackupStale: RUNBOOKS.backups,
  CERPCompleteBackupStale: RUNBOOKS.backups,
  CERPCompleteBackupIncomplete: RUNBOOKS.backups,
  CERPBackupRepositoryCapacityCritical: RUNBOOKS.backups,
  CERPCriticalJobFailed: RUNBOOKS.jobs,
  CERPMigrationFailed: RUNBOOKS.migrations,
});

const DEPENDENCY_METADATA = Object.freeze({
  database: { label: "Base PostgreSQL", category: "data" as const, runbook: RUNBOOKS.database },
  ged_storage: { label: "Stockage GED", category: "documents" as const, runbook: RUNBOOKS.documents },
  operational_media_storage: { label: "Stockage des médias opérationnels", category: "documents" as const, runbook: RUNBOOKS.documents },
  antivirus: { label: "Antivirus documentaire", category: "documents" as const, runbook: RUNBOOKS.antivirus },
  realtime: { label: "Temps réel", category: "runtime" as const, runbook: RUNBOOKS.api },
});

const QUEUE_LABELS: Readonly<Record<QueueSnapshot["id"], string>> = Object.freeze({
  advanced_reminders: "Relances clients",
  webhook_delivery: "Livraisons webhook",
  electronic_invoicing: "Facturation électronique",
});

function isoOrNull(milliseconds: number): string | null {
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}

function freshnessSeconds(now: Date, timestamp: string | null): number | null {
  if (!timestamp) return null;
  const milliseconds = new Date(timestamp).getTime();
  if (!Number.isFinite(milliseconds)) return null;
  return Math.max(0, Math.floor((now.getTime() - milliseconds) / 1_000));
}

function safeOperatorUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!(["http:", "https:"] as const).includes(url.protocol as "http:" | "https:")) return null;
    if (url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function fact(params: Omit<OperationsFact, "observed_at"> & { observed_at?: string }, observedAt: string): OperationsFact {
  return { ...params, observed_at: params.observed_at ?? observedAt };
}

function readPatchManifest(environment = process.env): PatchManifest {
  const patchRoot = path.resolve(environment.CERP_PATCHES_DIR?.trim() || path.join(process.cwd(), "db", "patches"));
  try {
    const rows = fs.readdirSync(patchRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => {
        const contents = fs.readFileSync(path.join(patchRoot, entry.name));
        return {
          filename: entry.name,
          sha256: crypto.createHash("sha256").update(contents).digest("hex"),
        };
      })
      .sort((left, right) => left.filename.localeCompare(right.filename));
    return rows.length > 0
      ? { available: true, rows, reason_code: null }
      : { available: false, rows: [], reason_code: "PATCH_MANIFEST_EMPTY" };
  } catch {
    return { available: false, rows: [], reason_code: "PATCH_MANIFEST_UNAVAILABLE" };
  }
}

function prometheusEndpoint(environment: NodeJS.ProcessEnv): URL | null {
  const raw = environment.CERP_OPERATIONS_PROMETHEUS_URL?.trim();
  if (!raw) return null;
  try {
    const base = new URL(raw.endsWith("/") ? raw : `${raw}/`);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return null;
    return new URL("api/v1/query", base);
  } catch {
    return null;
  }
}

async function prometheusQuery(
  endpoint: URL,
  query: string,
  environment: NodeJS.ProcessEnv,
): Promise<readonly PrometheusSample[]> {
  const url = new URL(endpoint);
  url.searchParams.set("query", query);
  const token = environment.CERP_OPERATIONS_PROMETHEUS_TOKEN?.trim();
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) throw new Error("PROMETHEUS_HTTP_ERROR");
  const raw = await response.text();
  if (raw.length > 1_000_000) throw new Error("PROMETHEUS_RESPONSE_TOO_LARGE");
  const body = JSON.parse(raw) as {
    status?: unknown;
    data?: { resultType?: unknown; result?: unknown };
  };
  if (body.status !== "success" || body.data?.resultType !== "vector" || !Array.isArray(body.data.result)) {
    throw new Error("PROMETHEUS_RESPONSE_INVALID");
  }
  return body.data.result.filter((item): item is PrometheusSample => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as { metric?: unknown; value?: unknown };
    return Boolean(candidate.metric && typeof candidate.metric === "object"
      && Array.isArray(candidate.value)
      && candidate.value.length === 2
      && typeof candidate.value[0] === "number"
      && typeof candidate.value[1] === "string");
  });
}

async function collectPrometheus(environment = process.env): Promise<PrometheusSnapshot> {
  const observedAt = new Date().toISOString();
  const endpoint = prometheusEndpoint(environment);
  if (!endpoint) {
    return {
      configured: false,
      available: false,
      reason_code: "PROMETHEUS_NOT_CONFIGURED",
      latency_ms: null,
      observed_at: observedAt,
      metrics: [],
      alerts: [],
    };
  }
  const startedAt = Date.now();
  try {
    const [metrics, alerts] = await Promise.all([
      prometheusQuery(
        endpoint,
        '{__name__=~"cerp_external_job_last_(success|failure)_timestamp_seconds|cerp_external_job_last_duration_seconds|cerp_backup_(complete|snapshot_bytes|document_references|duration_seconds|recovery_point_lag_seconds|repository_bytes|repository_capacity_bytes)"}',
        environment,
      ),
      prometheusQuery(endpoint, 'ALERTS{alertstate="firing"}', environment),
    ]);
    return {
      configured: true,
      available: true,
      reason_code: null,
      latency_ms: Date.now() - startedAt,
      observed_at: observedAt,
      metrics,
      alerts,
    };
  } catch {
    return {
      configured: true,
      available: false,
      reason_code: "PROMETHEUS_QUERY_FAILED",
      latency_ms: Date.now() - startedAt,
      observed_at: observedAt,
      metrics: [],
      alerts: [],
    };
  }
}

function numericMetric(
  samples: readonly PrometheusSample[],
  name: string,
  labels: Readonly<Record<string, string>> = {},
): number | null {
  const values = samples
    .filter((sample) => sample.metric.__name__ === name
      && Object.entries(labels).every(([key, value]) => sample.metric[key] === value))
    .map((sample) => Number(sample.value[1]))
    .filter(Number.isFinite);
  return values.length > 0 ? Math.max(...values) : null;
}

function dependencySignals(
  report: ReadinessReport,
  metrics: ReturnType<typeof getOperationalMetricsSnapshot>,
  now: Date,
  logsUrl: string | null,
): OperationsSignal[] {
  return Object.entries(report.checks).map(([id, check]) => {
    const name = id as keyof typeof DEPENDENCY_METADATA;
    const metadata = DEPENDENCY_METADATA[name];
    const history = metrics.dependencies[name];
    const lastSuccess = isoOrNull(history?.lastSucceededAtMs ?? (check.status === "up" ? now.getTime() : 0));
    const lastError = isoOrNull(history?.lastFailedAtMs ?? (check.status === "up" ? 0 : now.getTime()));
    const facts: OperationsFact[] = [
      fact({ key: "required", label: "Obligatoire", value: check.required, unit: "boolean", period: "instantané", source: check.source, reliability: "MEASURED" }, check.checked_at),
    ];
    if (name === "database") {
      facts.push(
        fact({ key: "pool_total", label: "Connexions pool", value: pool.totalCount, unit: "connections", period: "instantané", source: "node_pg_pool", reliability: "MEASURED" }, check.checked_at),
        fact({ key: "pool_idle", label: "Connexions libres", value: pool.idleCount, unit: "connections", period: "instantané", source: "node_pg_pool", reliability: "MEASURED" }, check.checked_at),
        fact({ key: "pool_waiting", label: "Requêtes en attente", value: pool.waitingCount, unit: "requests", period: "instantané", source: "node_pg_pool", reliability: "MEASURED" }, check.checked_at),
      );
    }
    if (name === "ged_storage" && metrics.ged_capacity) {
      facts.push(
        fact({ key: "used_ratio", label: "Occupation", value: metrics.ged_capacity.usedRatio, unit: "ratio", period: "instantané", source: "filesystem_probe", reliability: "MEASURED" }, check.checked_at),
        fact({ key: "available_bytes", label: "Espace disponible", value: metrics.ged_capacity.availableBytes, unit: "bytes", period: "instantané", source: "filesystem_probe", reliability: "MEASURED" }, check.checked_at),
      );
    }
    if (name === "antivirus" && metrics.ged_quarantine) {
      facts.push(
        fact({ key: "pending", label: "Scans en attente", value: metrics.ged_quarantine.pending, unit: "documents", period: "instantané", source: "ged_upload_sessions", reliability: "MEASURED" }, check.checked_at),
        fact({ key: "infected", label: "Documents infectés", value: metrics.ged_quarantine.infected, unit: "documents", period: "instantané", source: "ged_upload_sessions", reliability: "MEASURED" }, check.checked_at),
        fact({ key: "scan_failed", label: "Scans échoués", value: metrics.ged_quarantine.scanFailed, unit: "documents", period: "instantané", source: "ged_upload_sessions", reliability: "MEASURED" }, check.checked_at),
      );
    }
    return {
      id: name,
      label: metadata.label,
      category: metadata.category,
      state: check.status === "up" ? "operational" : check.status,
      required: check.required,
      current: check.status.toUpperCase(),
      reason_code: check.reason_code,
      affected_scope: check.affected_scope,
      latency_ms: check.latency_ms,
      observed_at: check.checked_at,
      freshness_seconds: check.freshness_seconds,
      last_success_at: lastSuccess,
      last_error_at: lastError,
      source: check.source,
      reliability: "MEASURED",
      runbook_url: metadata.runbook,
      logs_url: logsUrl,
      facts,
    } satisfies OperationsSignal;
  });
}

function migrationSignal(
  ledger: MigrationLedgerSnapshot | null,
  manifest: PatchManifest,
  now: Date,
  logsUrl: string | null,
): OperationsSignal {
  const observedAt = now.toISOString();
  if (!ledger || !manifest.available) {
    return {
      id: "migrations",
      label: "Migrations SQL",
      category: "data",
      state: "unavailable",
      required: true,
      current: "UNAVAILABLE",
      reason_code: manifest.reason_code ?? "MIGRATION_LEDGER_PROBE_FAILED",
      affected_scope: "release_database_upgrade",
      latency_ms: ledger?.latency_ms ?? null,
      observed_at: observedAt,
      freshness_seconds: null,
      last_success_at: null,
      last_error_at: null,
      source: "runtime_patch_manifest_and_cerp_schema_migrations",
      reliability: "UNAVAILABLE",
      runbook_url: RUNBOOKS.migrations,
      logs_url: logsUrl,
      facts: [],
    };
  }
  if (!ledger.registry_exists) {
    return {
      id: "migrations",
      label: "Migrations SQL",
      category: "data",
      state: "down",
      required: true,
      current: "REGISTRY_MISSING",
      reason_code: "MIGRATION_REGISTRY_MISSING",
      affected_scope: "release_database_upgrade",
      latency_ms: ledger.latency_ms,
      observed_at: observedAt,
      freshness_seconds: null,
      last_success_at: null,
      last_error_at: observedAt,
      source: "runtime_patch_manifest_and_cerp_schema_migrations",
      reliability: "MEASURED",
      runbook_url: RUNBOOKS.migrations,
      logs_url: logsUrl,
      facts: [],
    };
  }
  const applied = new Map(ledger.rows.map((row) => [row.filename, row]));
  const expected = new Set(manifest.rows.map((row) => row.filename));
  const pending = manifest.rows.filter((row) => !applied.has(row.filename));
  const mismatches = manifest.rows.filter((row) => {
    const installed = applied.get(row.filename);
    return installed ? installed.sha256 !== row.sha256 : false;
  });
  const unexpected = ledger.rows.filter((row) => !expected.has(row.filename));
  const lastSuccess = ledger.rows
    .map((row) => row.applied_at)
    .sort()
    .at(-1) ?? null;
  const state: OperationsState = mismatches.length > 0 ? "down" : pending.length > 0 || unexpected.length > 0 ? "degraded" : "operational";
  const current = mismatches.length > 0 ? "CHECKSUM_MISMATCH" : pending.length > 0 ? "PATCHES_PENDING" : unexpected.length > 0 ? "UNEXPECTED_LEDGER_ROWS" : "UP_TO_DATE";
  return {
    id: "migrations",
    label: "Migrations SQL",
    category: "data",
    state,
    required: true,
    current,
    reason_code: state === "operational" ? null : current,
    affected_scope: "release_database_upgrade",
    latency_ms: ledger.latency_ms,
    observed_at: observedAt,
    freshness_seconds: freshnessSeconds(now, lastSuccess),
    last_success_at: lastSuccess,
    last_error_at: mismatches.length > 0 ? observedAt : null,
    source: "runtime_patch_manifest_and_cerp_schema_migrations",
    reliability: "MEASURED",
    runbook_url: RUNBOOKS.migrations,
    logs_url: logsUrl,
    facts: [
      fact({ key: "expected", label: "Patches livrés", value: manifest.rows.length, unit: "patches", period: "release courante", source: "runtime_patch_manifest", reliability: "MEASURED" }, observedAt),
      fact({ key: "applied", label: "Patches appliqués", value: ledger.rows.length, unit: "patches", period: "historique complet", source: "cerp_schema_migrations", reliability: "MEASURED" }, observedAt),
      fact({ key: "pending", label: "Patches en attente", value: pending.length, unit: "patches", period: "release courante", source: "manifest_ledger_comparison", reliability: "DERIVED" }, observedAt),
      fact({ key: "checksum_mismatches", label: "Empreintes divergentes", value: mismatches.length, unit: "patches", period: "release courante", source: "manifest_ledger_comparison", reliability: "DERIVED" }, observedAt),
    ],
  };
}

function queueSignals(queues: readonly QueueSnapshot[], now: Date, logsUrl: string | null): OperationsSignal[] {
  const observedAt = now.toISOString();
  return queues.map((queue) => {
    const age = freshnessSeconds(now, queue.oldest_pending_at);
    const state: OperationsState = !queue.available
      ? "unavailable"
      : queue.failures > 0
        ? "degraded"
        : age !== null && age > 3_600
          ? "stale"
          : "operational";
    return {
      id: `queue_${queue.id}`,
      label: `File — ${QUEUE_LABELS[queue.id]}`,
      category: "jobs",
      state,
      required: false,
      current: !queue.available ? "UNAVAILABLE" : queue.pending > 0 ? "PENDING" : "IDLE",
      reason_code: queue.reason_code ?? (state === "stale" ? "OLDEST_ITEM_OVER_ONE_HOUR" : queue.failures > 0 ? "FAILED_ITEMS_PRESENT" : null),
      affected_scope: queue.id,
      latency_ms: queue.latency_ms,
      observed_at: observedAt,
      freshness_seconds: age,
      last_success_at: queue.last_success_at,
      last_error_at: queue.last_error_at,
      source: `postgres_${queue.id}_queue`,
      reliability: queue.available ? "MEASURED" : "UNAVAILABLE",
      runbook_url: RUNBOOKS.jobs,
      logs_url: logsUrl,
      facts: queue.available ? [
        fact({ key: "pending", label: "En attente", value: queue.pending, unit: "items", period: "instantané", source: `postgres_${queue.id}_queue`, reliability: "MEASURED" }, observedAt),
        fact({ key: "failures", label: "En échec", value: queue.failures, unit: "items", period: "instantané", source: `postgres_${queue.id}_queue`, reliability: "MEASURED" }, observedAt),
      ] : [],
    };
  });
}

function runtimeJobSignals(
  metrics: ReturnType<typeof getOperationalMetricsSnapshot>,
  now: Date,
  logsUrl: string | null,
): OperationsSignal[] {
  const observedAt = now.toISOString();
  return Object.entries(metrics.jobs).map(([id, job]) => {
    const lastSuccess = isoOrNull(job.lastSucceededAtMs);
    const lastError = isoOrNull(job.lastFailedAtMs);
    const state: OperationsState = job.running || job.lastSucceededAtMs >= job.lastFailedAtMs
      ? "operational"
      : "down";
    return {
      id: `job_${id}`,
      label: `Job — ${id}`,
      category: "jobs",
      state,
      required: id === "advanced_reminders",
      current: job.running ? "RUNNING" : state === "operational" ? "IDLE" : "FAILED",
      reason_code: state === "down" ? "LAST_RUN_FAILED" : null,
      affected_scope: id,
      latency_ms: null,
      observed_at: observedAt,
      freshness_seconds: freshnessSeconds(now, lastSuccess ?? lastError),
      last_success_at: lastSuccess,
      last_error_at: lastError,
      source: "process_job_metrics",
      reliability: "MEASURED",
      runbook_url: RUNBOOKS.jobs,
      logs_url: logsUrl,
      facts: [
        fact({ key: "failures", label: "Échecs depuis démarrage", value: job.failures, unit: "runs", period: "depuis démarrage du processus", source: "process_job_metrics", reliability: "MEASURED" }, observedAt),
      ],
    };
  });
}

function externalJobSignal(params: {
  id: "backup_database" | "backup_files" | "backup_complete" | "migrations_heartbeat";
  label: string;
  required: boolean;
  maxAgeSeconds: number | null;
  prometheus: PrometheusSnapshot;
  now: Date;
  logsUrl: string | null;
}): OperationsSignal {
  const { id, prometheus, now } = params;
  const metricJob = id === "migrations_heartbeat" ? "migrations" : id;
  const successSeconds = numericMetric(prometheus.metrics, "cerp_external_job_last_success_timestamp_seconds", { job: metricJob });
  const failureSeconds = numericMetric(prometheus.metrics, "cerp_external_job_last_failure_timestamp_seconds", { job: metricJob });
  const durationSeconds = numericMetric(prometheus.metrics, "cerp_external_job_last_duration_seconds", { job: metricJob });
  const lastSuccess = successSeconds && successSeconds > 0 ? new Date(successSeconds * 1_000).toISOString() : null;
  const lastError = failureSeconds && failureSeconds > 0 ? new Date(failureSeconds * 1_000).toISOString() : null;
  const freshness = freshnessSeconds(now, lastSuccess);
  const complete = id === "backup_complete" ? numericMetric(prometheus.metrics, "cerp_backup_complete") : null;
  let state: OperationsState = "operational";
  let reasonCode: string | null = null;
  if (!prometheus.available) {
    state = "unavailable";
    reasonCode = prometheus.reason_code;
  } else if (!lastSuccess) {
    state = "unavailable";
    reasonCode = "JOB_SUCCESS_HEARTBEAT_MISSING";
  } else if (lastError && new Date(lastError).getTime() > new Date(lastSuccess).getTime()) {
    state = "down";
    reasonCode = "LAST_RUN_FAILED";
  } else if (complete !== null && complete !== 1) {
    state = "down";
    reasonCode = "BACKUP_RECOVERY_SET_INCOMPLETE";
  } else if (params.maxAgeSeconds !== null && freshness !== null && freshness > params.maxAgeSeconds) {
    state = "stale";
    reasonCode = "SUCCESS_HEARTBEAT_STALE";
  }
  const facts: OperationsFact[] = [];
  if (durationSeconds !== null) {
    facts.push(fact({ key: "duration", label: "Durée du dernier passage", value: durationSeconds, unit: "seconds", period: "dernier passage", source: "prometheus_textfile_heartbeat", reliability: "MEASURED" }, prometheus.observed_at));
  }
  if (id === "backup_complete") {
    for (const [metric, label, unit] of [
      ["cerp_backup_snapshot_bytes", "Taille logique", "bytes"],
      ["cerp_backup_document_references", "Références documentaires", "documents"],
      ["cerp_backup_recovery_point_lag_seconds", "Décalage du point de reprise", "seconds"],
      ["cerp_backup_repository_bytes", "Dépôt hors site utilisé", "bytes"],
      ["cerp_backup_repository_capacity_bytes", "Capacité déclarée du dépôt", "bytes"],
    ] as const) {
      const value = numericMetric(prometheus.metrics, metric);
      if (value !== null) facts.push(fact({ key: metric, label, value, unit, period: "dernier recovery set", source: "prometheus_backup_metrics", reliability: "MEASURED" }, prometheus.observed_at));
    }
  }
  return {
    id,
    label: params.label,
    category: id === "migrations_heartbeat" ? "data" : "backups",
    state,
    required: params.required,
    current: state === "operational" ? "OK" : state.toUpperCase(),
    reason_code: reasonCode,
    affected_scope: id === "backup_database" ? "database_recovery" : id === "backup_files" ? "ged_and_generated_files_recovery" : id === "backup_complete" ? "complete_db_and_documents_recovery" : "release_database_upgrade",
    latency_ms: prometheus.latency_ms,
    observed_at: prometheus.observed_at,
    freshness_seconds: freshness,
    last_success_at: lastSuccess,
    last_error_at: lastError,
    source: "prometheus_external_job_heartbeat",
    reliability: prometheus.available ? "MEASURED" : "UNAVAILABLE",
    runbook_url: id === "migrations_heartbeat" ? RUNBOOKS.migrations : RUNBOOKS.backups,
    logs_url: params.logsUrl,
    facts,
  };
}

function integrationSignals(
  webhook: ReturnType<typeof webhookReadiness>,
  electronicInvoice: Awaited<ReturnType<typeof svcElectronicInvoiceReadiness>> | null,
  queues: readonly QueueSnapshot[],
  now: Date,
  logsUrl: string | null,
): OperationsSignal[] {
  const observedAt = now.toISOString();
  const queueById = new Map(queues.map((queue) => [queue.id, queue]));
  const webhookQueue = queueById.get("webhook_delivery");
  const invoiceQueue = queueById.get("electronic_invoicing");
  return [
    {
      id: "integration_webhooks",
      label: "API partenaires — webhooks",
      category: "integrations",
      state: webhook.ready ? "operational" : "unavailable",
      required: false,
      current: webhook.ready ? "READY" : "NOT_CONFIGURED",
      reason_code: webhook.ready ? null : !webhook.encryption_key_configured ? "ENCRYPTION_KEY_NOT_CONFIGURED" : "DELIVERY_DISABLED",
      affected_scope: "partner_webhook_delivery",
      latency_ms: null,
      observed_at: observedAt,
      freshness_seconds: freshnessSeconds(now, webhookQueue?.last_success_at ?? null),
      last_success_at: webhookQueue?.last_success_at ?? null,
      last_error_at: webhookQueue?.last_error_at ?? null,
      source: "webhook_runtime_configuration",
      reliability: "CONFIGURED",
      runbook_url: RUNBOOKS.integrations,
      logs_url: logsUrl,
      facts: [
        fact({ key: "delivery_enabled", label: "Livraison activée", value: webhook.delivery_enabled, unit: "boolean", period: "configuration courante", source: "webhook_runtime_configuration", reliability: "CONFIGURED" }, observedAt),
      ],
    },
    {
      id: "integration_electronic_invoicing",
      label: "Facturation électronique — PA",
      category: "integrations",
      state: electronicInvoice?.ready ? "operational" : "unavailable",
      required: false,
      current: electronicInvoice?.ready ? "READY" : "NOT_QUALIFIED",
      reason_code: electronicInvoice?.reason ?? "EINVOICE_READINESS_FAILED",
      affected_scope: "electronic_invoice_exchange",
      latency_ms: null,
      observed_at: observedAt,
      freshness_seconds: freshnessSeconds(now, invoiceQueue?.last_success_at ?? null),
      last_success_at: invoiceQueue?.last_success_at ?? null,
      last_error_at: invoiceQueue?.last_error_at ?? null,
      source: "einvoice_provider_registry",
      reliability: electronicInvoice ? "MEASURED" : "UNAVAILABLE",
      runbook_url: RUNBOOKS.integrations,
      logs_url: logsUrl,
      facts: electronicInvoice ? [
        fact({ key: "adapter_count", label: "Adaptateurs chargés", value: electronicInvoice.registered_adapters.length, unit: "adapters", period: "release courante", source: "einvoice_provider_registry", reliability: "MEASURED" }, observedAt),
      ] : [],
    },
  ];
}

function activeAlerts(prometheus: PrometheusSnapshot): OperationsAlert[] {
  if (!prometheus.available) return [];
  return prometheus.alerts
    .filter((sample) => Boolean(sample.metric.alertname))
    .map((sample) => ({
      name: sample.metric.alertname,
      severity: (["P0", "P1", "P2"] as const).includes(sample.metric.severity as "P0" | "P1" | "P2")
        ? sample.metric.severity as "P0" | "P1" | "P2"
        : "UNKNOWN",
      affected_scope: sample.metric.affected_scope ?? "unknown",
      observed_at: new Date(sample.value[0] * 1_000).toISOString(),
      source: "prometheus_alerts",
      runbook_url: ALERT_RUNBOOKS[sample.metric.alertname] ?? null,
    }));
}

const defaultDependencies: OperationsConsoleDependencies = {
  now: () => new Date(),
  readiness: () => collectReadiness(pool),
  migrationLedger: () => repoMigrationLedger(),
  queueSnapshots: () => repoQueueSnapshots(),
  patchManifest: () => readPatchManifest(),
  prometheus: () => collectPrometheus(),
  runtimeMetrics: getOperationalMetricsSnapshot,
  webhookReadiness,
  electronicInvoiceReadiness: svcElectronicInvoiceReadiness,
  environment: process.env,
};

export async function getOperationsConsoleSnapshot(
  overrides: Partial<OperationsConsoleDependencies> = {},
): Promise<OperationsConsoleSnapshot> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const now = dependencies.now();
  const environment = dependencies.environment;
  const logsUrl = safeOperatorUrl(environment.CERP_OPERATIONS_LOGS_URL);
  const dashboardsUrl = safeOperatorUrl(environment.CERP_OPERATIONS_DASHBOARD_URL);
  const manifest = dependencies.patchManifest();
  const [readiness, ledgerResult, queues, prometheus, electronicInvoice] = await Promise.all([
    dependencies.readiness(),
    dependencies.migrationLedger().catch(() => null),
    dependencies.queueSnapshots().catch(() => []),
    dependencies.prometheus(),
    dependencies.electronicInvoiceReadiness().catch(() => null),
  ]);
  const runtimeMetrics = dependencies.runtimeMetrics();
  const signals: OperationsSignal[] = [
    {
      id: "api",
      label: "API CERP+",
      category: "runtime",
      state: readiness.status === "ready" ? "operational" : "down",
      required: true,
      current: readiness.status.toUpperCase(),
      reason_code: readiness.status === "ready" ? null : "REQUIRED_DEPENDENCY_NOT_READY",
      affected_scope: "all_user_flows",
      latency_ms: null,
      observed_at: readiness.observed_at,
      freshness_seconds: 0,
      last_success_at: readiness.status === "ready" ? readiness.observed_at : null,
      last_error_at: readiness.status === "ready" ? null : readiness.observed_at,
      source: "application_readiness",
      reliability: "MEASURED",
      runbook_url: RUNBOOKS.api,
      logs_url: logsUrl,
      facts: [
        fact({ key: "uptime", label: "Disponibilité du processus", value: Math.floor(process.uptime()), unit: "seconds", period: "depuis démarrage du processus", source: "node_process", reliability: "MEASURED" }, readiness.observed_at),
      ],
    },
    ...dependencySignals(readiness, runtimeMetrics, now, logsUrl),
    migrationSignal(ledgerResult, manifest, now, logsUrl),
    ...queueSignals(queues, now, logsUrl),
    ...runtimeJobSignals(runtimeMetrics, now, logsUrl),
    externalJobSignal({ id: "backup_database", label: "Sauvegarde PostgreSQL", required: true, maxAgeSeconds: 93_600, prometheus, now, logsUrl }),
    externalJobSignal({ id: "backup_files", label: "Sauvegarde GED et fichiers", required: true, maxAgeSeconds: 93_600, prometheus, now, logsUrl }),
    externalJobSignal({ id: "backup_complete", label: "Recovery set complet hors site", required: true, maxAgeSeconds: 90_000, prometheus, now, logsUrl }),
    externalJobSignal({ id: "migrations_heartbeat", label: "Dernière exécution du gate migrations", required: false, maxAgeSeconds: null, prometheus, now, logsUrl }),
    ...integrationSignals(dependencies.webhookReadiness(), electronicInvoice, queues, now, logsUrl),
  ];
  const required = signals.filter((signal) => signal.required);
  const overall = required.some((signal) => signal.state === "down")
    ? "down"
    : required.some((signal) => signal.state !== "operational")
      ? "degraded"
      : "operational";
  const version = runtimeMetadata.version;
  const commitCandidate = environment.CERP_RELEASE_COMMIT?.trim() || (version !== "unknown" ? version : "");
  return {
    observed_at: now.toISOString(),
    overall_state: overall,
    read_only: true,
    service: {
      name: runtimeMetadata.service,
      version,
      commit: /^[a-zA-Z0-9._:-]{7,64}$/.test(commitCandidate) ? commitCandidate : null,
      environment: runtimeMetadata.environment,
    },
    signals,
    alerts: activeAlerts(prometheus),
    links: { dashboards: dashboardsUrl, logs: logsUrl },
    limitations: [
      "Cette console n'exécute aucune réparation, migration, restauration, purge de file ni libération de quarantaine.",
      "Les historiques de jobs applicatifs sont limités à la durée de vie du processus ; Prometheus porte l'historique durable.",
      "Une source non configurée ou inaccessible reste indisponible et n'est jamais assimilée à un succès.",
    ],
  };
}

export const operationsConsoleInternals = {
  collectPrometheus,
  readPatchManifest,
  safeOperatorUrl,
};
