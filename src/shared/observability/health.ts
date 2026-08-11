import type { Pool } from "pg";

import { checkVaultHealth } from "../../module/ged/services/ged-vault.service";
import {
  getUploadScannerStartupConfiguration,
  probeUploadScannerHealth,
  type UploadScannerStartupConfiguration,
} from "../uploads/upload-scanner";
import { getRealtimeReadiness } from "../../sockets/sockeServer";
import { setDependencyState, setGedCapacity, setGedQuarantineMetrics } from "./metrics";
import { runtimeMetadata } from "./runtime";

export type HealthStatus = "up" | "down" | "degraded";
export type HealthDependency = "database" | "ged_storage" | "antivirus" | "realtime";

export type HealthCheck = Readonly<{
  status: HealthStatus;
  required: boolean;
  latency_ms: number;
  checked_at: string;
  reason_code: string | null;
  affected_scope: string;
  source: string;
  freshness_seconds: number;
  reliability: "MEASURED" | "STARTUP_PROBE";
}>;

export type ReadinessReport = Readonly<{
  status: "ready" | "not_ready";
  service: string;
  version: string;
  environment: string;
  observed_at: string;
  checks: Record<HealthDependency, HealthCheck>;
}>;

type HealthProbeDependencies = Readonly<{
  queryDatabase: () => Promise<void>;
  checkGed: typeof checkVaultHealth;
  scanner: () => Promise<UploadScannerStartupConfiguration>;
  realtime: typeof getRealtimeReadiness;
}>;

const ALL_DEPENDENCIES: HealthDependency[] = ["database", "ged_storage", "antivirus", "realtime"];
const AFFECTED_SCOPES: Record<HealthDependency, string> = {
  database: "all_transactional_flows",
  ged_storage: "document_upload_and_download",
  antivirus: "file_uploads",
  realtime: "collaborative_live_updates",
};

let scannerStartupState: UploadScannerStartupConfiguration | null = null;

export function setScannerStartupState(state: UploadScannerStartupConfiguration): void {
  scannerStartupState = state;
}

function requiredDependencies(environment = process.env): Set<HealthDependency> {
  const configured = environment.CERP_READINESS_REQUIRED_DEPENDENCIES
    ?.split(",")
    .map((value) => value.trim())
    .filter((value): value is HealthDependency => ALL_DEPENDENCIES.includes(value as HealthDependency));
  if (configured && configured.length > 0) return new Set(configured);
  return new Set(environment.NODE_ENV === "production" ? ALL_DEPENDENCIES : ["database"]);
}

async function timedProbe<T>(operation: () => Promise<T>, timeoutMs = 1_500): Promise<{
  value: T | null;
  error: unknown;
  latencyMs: number;
}> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("health probe timeout"), { code: "PROBE_TIMEOUT" })), timeoutMs);
      }),
    ]);
    return { value, error: null, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { value: null, error, latencyMs: Date.now() - startedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildCheck(
  name: HealthDependency,
  status: HealthStatus,
  required: boolean,
  latencyMs: number,
  reasonCode: string | null,
  reliability: HealthCheck["reliability"] = "MEASURED"
): HealthCheck {
  return {
    status,
    required,
    latency_ms: latencyMs,
    checked_at: new Date().toISOString(),
    reason_code: reasonCode,
    affected_scope: AFFECTED_SCOPES[name],
    source: name === "database" ? "postgres_probe" : name === "ged_storage" ? "filesystem_probe" : name === "antivirus" ? "clamav_live_probe" : "realtime_control_plane",
    freshness_seconds: 0,
    reliability,
  };
}

export async function collectReadiness(
  pool: Pool,
  overrides: Partial<HealthProbeDependencies> = {},
  environment = process.env
): Promise<ReadinessReport> {
  const required = requiredDependencies(environment);
  const dependencies: HealthProbeDependencies = {
    queryDatabase: async () => {
      await pool.query("SELECT 1");
    },
    checkGed: checkVaultHealth,
    scanner: () => probeUploadScannerHealth(scannerStartupState ?? getUploadScannerStartupConfiguration()),
    realtime: getRealtimeReadiness,
    ...overrides,
  };

  const [databaseProbe, gedProbe, scannerProbe, quarantineProbe] = await Promise.all([
    timedProbe(dependencies.queryDatabase),
    timedProbe(dependencies.checkGed),
    timedProbe(dependencies.scanner, 2_500),
    timedProbe(async () => {
      const result = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE quarantine_status = 'quarantined' AND scan_status = 'pending')::int AS pending,
           COUNT(*) FILTER (WHERE quarantine_status = 'quarantined' AND scan_status = 'clean')::int AS clean,
           COUNT(*) FILTER (WHERE quarantine_status = 'quarantined' AND scan_status = 'infected')::int AS infected,
           COUNT(*) FILTER (WHERE quarantine_status = 'quarantined' AND scan_status = 'scan_failed')::int AS scan_failed,
           COALESCE(EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (WHERE quarantine_status = 'quarantined'))), 0)::bigint AS oldest_age_seconds
         FROM public.ged_upload_sessions`
      );
      return result.rows[0] as Record<string, string | number>;
    }),
  ]);

  const realtimeStartedAt = Date.now();
  let realtimeReady = false;
  let realtimeError: unknown = null;
  try {
    realtimeReady = dependencies.realtime().ready;
  } catch (error) {
    realtimeError = error;
  }
  const realtimeLatency = Date.now() - realtimeStartedAt;

  const gedHealthy = Boolean(gedProbe.value?.healthy);
  setGedCapacity({
    capacityBytes: gedProbe.value?.capacity_bytes ?? null,
    availableBytes: gedProbe.value?.available_bytes ?? null,
    usedRatio: gedProbe.value?.used_ratio ?? null,
    inodeTotal: gedProbe.value?.inode_total ?? null,
    inodeFree: gedProbe.value?.inode_free ?? null,
  });
  const quarantine = quarantineProbe.value;
  setGedQuarantineMetrics(quarantine
    ? {
        pending: Number(quarantine.pending ?? 0),
        clean: Number(quarantine.clean ?? 0),
        infected: Number(quarantine.infected ?? 0),
        scanFailed: Number(quarantine.scan_failed ?? 0),
        oldestAgeSeconds: Number(quarantine.oldest_age_seconds ?? 0),
      }
    : null);
  const checks: Record<HealthDependency, HealthCheck> = {
    database: buildCheck(
      "database",
      databaseProbe.error ? "down" : "up",
      required.has("database"),
      databaseProbe.latencyMs,
      databaseProbe.error ? ((databaseProbe.error as { code?: string }).code ?? "DB_PROBE_FAILED") : null
    ),
    ged_storage: buildCheck(
      "ged_storage",
      gedHealthy ? "up" : (required.has("ged_storage") ? "down" : "degraded"),
      required.has("ged_storage"),
      gedProbe.latencyMs,
      gedHealthy ? null : (gedProbe.error ? "GED_PROBE_FAILED" : "GED_NOT_READY")
    ),
    antivirus: buildCheck(
      "antivirus",
      scannerProbe.value?.ready ? "up" : (required.has("antivirus") ? "down" : "degraded"),
      required.has("antivirus"),
      scannerProbe.latencyMs,
      scannerProbe.value?.ready ? null : scannerProbe.value?.reason ?? (scannerProbe.error ? "ANTIVIRUS_PROBE_FAILED" : "ANTIVIRUS_NOT_READY")
    ),
    realtime: buildCheck(
      "realtime",
      realtimeReady ? "up" : (required.has("realtime") ? "down" : "degraded"),
      required.has("realtime"),
      realtimeLatency,
      realtimeReady ? null : (realtimeError ? "REALTIME_PROBE_FAILED" : "REALTIME_NOT_READY")
    ),
  };

  for (const name of ALL_DEPENDENCIES) {
    setDependencyState(name, checks[name].status === "up", checks[name].latency_ms);
  }

  const ready = ALL_DEPENDENCIES.every((name) => !checks[name].required || checks[name].status === "up");
  return {
    status: ready ? "ready" : "not_ready",
    ...runtimeMetadata,
    observed_at: new Date().toISOString(),
    checks,
  };
}
