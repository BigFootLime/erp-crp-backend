import { describe, expect, it } from "vitest";

import type { ReadinessReport } from "../../../shared/observability/health";
import {
  getOperationsConsoleSnapshot,
  operationsConsoleInternals,
  type OperationsConsoleDependencies,
  type PrometheusSnapshot,
} from "./operations-console.service";

const NOW = new Date("2026-08-15T02:00:00.000Z");

function readiness(status: ReadinessReport["status"] = "ready"): ReadinessReport {
  const check = (source: string) => ({
    status: status === "ready" ? "up" as const : "down" as const,
    required: true,
    latency_ms: 12,
    checked_at: NOW.toISOString(),
    reason_code: status === "ready" ? null : "PROBE_FAILED",
    affected_scope: "test_scope",
    source,
    freshness_seconds: 0,
    reliability: "MEASURED" as const,
  });
  return {
    status,
    service: "cerp-api",
    version: "abc1234",
    environment: "test",
    observed_at: NOW.toISOString(),
    checks: {
      database: check("postgres_probe"),
      ged_storage: check("filesystem_probe"),
      antivirus: check("clamav_live_probe"),
      realtime: check("realtime_control_plane"),
    },
  };
}

function sample(name: string, value: number, labels: Readonly<Record<string, string>> = {}) {
  return {
    metric: { __name__: name, ...labels },
    value: [NOW.getTime() / 1_000, String(value)] as const,
  };
}

function prometheus(overrides: Partial<PrometheusSnapshot> = {}): PrometheusSnapshot {
  const recent = NOW.getTime() / 1_000 - 60;
  return {
    configured: true,
    available: true,
    reason_code: null,
    latency_ms: 24,
    observed_at: NOW.toISOString(),
    metrics: [
      sample("cerp_external_job_last_success_timestamp_seconds", recent, { job: "backup_database" }),
      sample("cerp_external_job_last_success_timestamp_seconds", recent, { job: "backup_files" }),
      sample("cerp_external_job_last_success_timestamp_seconds", recent, { job: "backup_complete" }),
      sample("cerp_external_job_last_success_timestamp_seconds", recent, { job: "migrations" }),
      sample("cerp_external_job_last_failure_timestamp_seconds", 0, { job: "backup_database" }),
      sample("cerp_external_job_last_failure_timestamp_seconds", 0, { job: "backup_files" }),
      sample("cerp_external_job_last_failure_timestamp_seconds", 0, { job: "backup_complete" }),
      sample("cerp_external_job_last_failure_timestamp_seconds", 0, { job: "migrations" }),
      sample("cerp_backup_complete", 1),
      sample("cerp_backup_snapshot_bytes", 1024),
      sample("cerp_backup_document_references", 12),
    ],
    alerts: [],
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<OperationsConsoleDependencies> = {},
): Partial<OperationsConsoleDependencies> {
  return {
    now: () => NOW,
    readiness: async () => readiness(),
    migrationLedger: async () => ({
      registry_exists: true,
      rows: [{ filename: "001.sql", sha256: "a".repeat(64), applied_at: "2026-08-14T00:00:00.000Z" }],
      latency_ms: 8,
    }),
    queueSnapshots: async () => [
      {
        id: "advanced_reminders",
        available: true,
        pending: 0,
        failures: 0,
        oldest_pending_at: null,
        last_success_at: "2026-08-15T01:55:00.000Z",
        last_error_at: null,
        latency_ms: 5,
        reason_code: null,
      },
    ],
    patchManifest: () => ({
      available: true,
      rows: [{ filename: "001.sql", sha256: "a".repeat(64) }],
      reason_code: null,
    }),
    prometheus: async () => prometheus(),
    runtimeMetrics: () => ({
      dependencies: {
        database: { up: true, checkedAtMs: NOW.getTime(), latencyMs: 12, lastSucceededAtMs: NOW.getTime(), lastFailedAtMs: 0 },
      },
      jobs: {
        advanced_reminders: { lastStartedAtMs: NOW.getTime() - 100, lastSucceededAtMs: NOW.getTime(), lastFailedAtMs: 0, failures: 0, running: false },
      },
      ged_capacity: { capacityBytes: 1000, availableBytes: 400, usedRatio: 0.6, inodeTotal: 100, inodeFree: 50 },
      ged_quarantine: { pending: 0, clean: 2, infected: 0, scanFailed: 0, oldestAgeSeconds: 0 },
    }),
    webhookReadiness: () => ({
      ready: true,
      environment: "sandbox",
      encryption_key_configured: true,
      delivery_enabled: true,
      signature_algorithm: "HMAC-SHA256",
      signature_version: "v1",
      replay_window_seconds: 300,
    }),
    electronicInvoiceReadiness: async () => ({
      ready: false,
      environment: "sandbox",
      reason: "NO_QUALIFIED_PROVIDER",
      message: "Aucune Plateforme Agréée réelle n'est qualifiée et activée pour cet environnement.",
      provider: null,
      registered_adapters: [],
    }),
    environment: {
      CERP_OPERATIONS_LOGS_URL: "https://grafana.example.test/explore",
      CERP_OPERATIONS_DASHBOARD_URL: "https://grafana.example.test/d/cerp",
      CERP_RELEASE_COMMIT: "abcdef1234567",
    },
    ...overrides,
  };
}

describe("SOL-31 operations console snapshot", () => {
  it("returns an operational, read-only snapshot from measured sources", async () => {
    const snapshot = await getOperationsConsoleSnapshot(dependencies());

    expect(snapshot.overall_state).toBe("operational");
    expect(snapshot.read_only).toBe(true);
    expect(snapshot.service.commit).toBe("abcdef1234567");
    expect(snapshot.signals.find((signal) => signal.id === "migrations")?.current).toBe("UP_TO_DATE");
    expect(snapshot.signals.find((signal) => signal.id === "backup_complete")?.facts).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "cerp_backup_document_references", value: 12, unit: "documents" })]),
    );
    expect(JSON.stringify(snapshot)).not.toContain("OPERATIONS_PROMETHEUS_TOKEN");
  });

  it("never turns an absent monitoring source into a healthy backup", async () => {
    const snapshot = await getOperationsConsoleSnapshot(dependencies({
      prometheus: async () => prometheus({
        configured: false,
        available: false,
        reason_code: "PROMETHEUS_NOT_CONFIGURED",
        latency_ms: null,
        metrics: [],
      }),
    }));

    expect(snapshot.overall_state).toBe("degraded");
    expect(snapshot.signals.find((signal) => signal.id === "backup_complete")).toMatchObject({
      state: "unavailable",
      reason_code: "PROMETHEUS_NOT_CONFIGURED",
      reliability: "UNAVAILABLE",
    });
  });

  it("marks stale backup heartbeats and checksum divergence", async () => {
    const old = NOW.getTime() / 1_000 - 100_000;
    const snapshot = await getOperationsConsoleSnapshot(dependencies({
      patchManifest: () => ({
        available: true,
        rows: [{ filename: "001.sql", sha256: "b".repeat(64) }],
        reason_code: null,
      }),
      prometheus: async () => prometheus({
        metrics: [
          sample("cerp_external_job_last_success_timestamp_seconds", old, { job: "backup_database" }),
          sample("cerp_external_job_last_success_timestamp_seconds", old, { job: "backup_files" }),
          sample("cerp_external_job_last_success_timestamp_seconds", old, { job: "backup_complete" }),
          sample("cerp_external_job_last_success_timestamp_seconds", old, { job: "migrations" }),
          sample("cerp_backup_complete", 1),
        ],
      }),
    }));

    expect(snapshot.overall_state).toBe("down");
    expect(snapshot.signals.find((signal) => signal.id === "migrations")?.state).toBe("down");
    expect(snapshot.signals.find((signal) => signal.id === "backup_complete")?.state).toBe("stale");
  });

  it("surfaces firing alerts without exposing their payloads", async () => {
    const snapshot = await getOperationsConsoleSnapshot(dependencies({
      prometheus: async () => prometheus({
        alerts: [{
          metric: { alertname: "CERPDatabaseUnavailable", severity: "P0", affected_scope: "all_transactional_flows" },
          value: [NOW.getTime() / 1_000, "1"],
        }],
      }),
    }));

    expect(snapshot.alerts).toEqual([expect.objectContaining({
      name: "CERPDatabaseUnavailable",
      severity: "P0",
      runbook_url: expect.stringContaining("database-degraded.md"),
    })]);
  });

  it("rejects operator links containing credentials or unsafe schemes", () => {
    expect(operationsConsoleInternals.safeOperatorUrl("javascript:alert(1)")).toBeNull();
    expect(operationsConsoleInternals.safeOperatorUrl("https://user:secret@example.test/logs")).toBeNull();
    expect(operationsConsoleInternals.safeOperatorUrl("https://grafana.example.test/logs")).toBe("https://grafana.example.test/logs");
    expect(operationsConsoleInternals.safeOperatorUrl("https://grafana.example.test/logs?token=secret#state")).toBe("https://grafana.example.test/logs");
  });
});
