import "dotenv/config";
import { assertDeploymentSecurity } from "./config/deployment-security";
import crypto from "node:crypto";
import { createServer } from "http";

import pool from "./config/database";
import {assertManagedDatabaseAtStartup} from './config/managed-database';
import {initializeSharedDirectorySite} from './shared-directory/site-runtime';
import { assertE2EIsolation, e2eListenHost } from "./config/e2e-isolation";
import { assertMfaStartupConfiguration } from "./module/auth/domain/mfa";
import { startAuthRateLimitMaintenance } from "./module/auth/services/auth-rate-limit.service";
import { startMfaArtifactMaintenance } from "./module/auth/services/mfa.service";
import { startExpiredLockMaintenance } from "./module/locks/services/locks.service";
import { startReminderMaintenance } from "./module/facturation/services/reminder-job.service";
import { startElectronicInvoiceMaintenance } from "./module/facturation/electronic-invoicing/electronic-invoice.service";
import { startSupplierInvoiceMaintenance } from "./module/supplier-invoices/supplier-invoice-inbound.service";
import { startEReportingMaintenance } from "./module/facturation/electronic-invoicing/electronic-invoice-reporting.service";
import { startWebhookDeliveryMaintenance } from "./module/integrations/webhooks/webhook.service";
import { startAuthoritativePdfArchiveMaintenance } from "./shared/authoritative-documents/authoritative-document.worker";
import { startPlanningForecastMaintenance } from "./module/planning/services/planning-forecast.worker";
import { startDurationLearningMaintenance } from "./module/planning/services/duration-learning.worker";
import { startCumpProjectionMaintenance } from "./module/stock/services/cump-projection.worker";
import { createApplicationShutdown } from "./shared/runtime/application-shutdown";
import { resolveRuntimeRole, startBackgroundRuntime } from "./shared/runtime/background-runtime";
import { startMaintenanceGroup } from "./shared/runtime/drainable-maintenance";
import { startWorkerHealthServer } from "./shared/runtime/worker-health-server";
import { preflightCriticalStorageAtStartup } from "./shared/runtime/critical-storage-preflight";
import { preflightSecureUploadStorageRoots } from "./shared/uploads/secure-upload";
import { getUploadScannerStartupConfiguration } from "./shared/uploads/upload-scanner";
import { initSocketServer, shutdownRealtimeSocketServer } from "./sockets/sockeServer";
import { runWithObservabilityContext } from "./shared/observability/context";
import { setScannerStartupState } from "./shared/observability/health";
import { errorFingerprint, installStructuredConsole, logger, safeErrorCode } from "./shared/observability/logger";

installStructuredConsole();

async function start(): Promise<void> {
  assertE2EIsolation();
  assertDeploymentSecurity();
  assertMfaStartupConfiguration();
  await assertManagedDatabaseAtStartup(pool);
  await initializeSharedDirectorySite(pool);
  // Run the GED identity/RW proof before the generic upload-root preflight:
  // otherwise a missing mount could be replaced by a newly created directory
  // on the system disk before the sentinel has been checked.
  const criticalStorage = await preflightCriticalStorageAtStartup();
  logger.info("critical_storage_preflight_succeeded", criticalStorage);
  // Run before importing routes: several upload middlewares allocate their
  // private quarantine during module initialization.
  const uploadRoots = preflightSecureUploadStorageRoots();
  logger.info("upload_storage_preflight_succeeded", { root_count: uploadRoots.length });

  const runtimeRole = resolveRuntimeRole();
  const uploadScanner = getUploadScannerStartupConfiguration();
  const app = runtimeRole === "worker" ? null : (await import("./config/app")).default;
  setScannerStartupState(uploadScanner);
  if (!uploadScanner.ready) {
    logger.error("upload_scanner_degraded", {
      mode: uploadScanner.mode,
      provider: uploadScanner.provider,
      reason_code: uploadScanner.reason,
      affected_scope: "file_uploads",
    });
  }

  const startMaintenance = () => startMaintenanceGroup([
    startAuthRateLimitMaintenance,
    startMfaArtifactMaintenance,
    startExpiredLockMaintenance,
    startReminderMaintenance,
    startElectronicInvoiceMaintenance,
    startSupplierInvoiceMaintenance,
    startEReportingMaintenance,
    startWebhookDeliveryMaintenance,
    startAuthoritativePdfArchiveMaintenance,
    startPlanningForecastMaintenance,
    startDurationLearningMaintenance,
    startCumpProjectionMaintenance,
  ]);
  const backgroundRuntime = startBackgroundRuntime({ pool, startMaintenance });
  const workerHealth = runtimeRole === "worker" ? await startWorkerHealthServer() : null;
  const port = Number.parseInt(process.env.PORT || "5000", 10);
  const httpServer = app ? createServer(app) : null;

  if (httpServer) {
    initSocketServer(httpServer);
    const listenHost = process.env.CERP_MANAGED_TEST_ID ? "127.0.0.1" : e2eListenHost();
    httpServer.listen(port, listenHost, () => {
      logger.info("upload_scanner_initialized", {
        mode: uploadScanner.mode,
        provider: uploadScanner.provider,
        ready: uploadScanner.ready,
      });
      logger.info("service_listening", { listen_host: listenHost, listen_port: port, runtime_role: runtimeRole });
    });
  } else {
    logger.info("background_worker_started", { runtime_role: runtimeRole, health_port: workerHealth?.port });
  }

  const configuredShutdownTimeout = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "10000", 10);
  const shutdownTimeoutMs = Number.isSafeInteger(configuredShutdownTimeout) && configuredShutdownTimeout > 0
    ? configuredShutdownTimeout
    : 10_000;
  const shutdown = createApplicationShutdown({
    httpServer: httpServer ?? { listening: false, close: () => undefined },
    stopRealtime: httpServer ? shutdownRealtimeSocketServer : async () => workerHealth?.close(),
    stopMaintenance: [backgroundRuntime.stop],
    closeDatabase: () => pool.end(),
    log: (type, fields) => logger.error(type, fields),
  }, shutdownTimeoutMs);

  let terminationStarted = false;
  const terminate = (signal: "SIGTERM" | "SIGINT" | "HTTP_CLOSE"): void => {
    if (terminationStarted) return;
    terminationStarted = true;
    void shutdown(signal).then(
      ({ exitCode }) => {
        process.exitCode = exitCode;
        process.exit(exitCode);
      },
      () => {
        process.exitCode = 1;
        process.exit(1);
      }
    );
  };

  process.once("SIGTERM", () => terminate("SIGTERM"));
  process.once("SIGINT", () => terminate("SIGINT"));
  httpServer?.once("close", () => terminate("HTTP_CLOSE"));
}

void start().catch((error) => {
  const correlationId = crypto.randomUUID();
  runWithObservabilityContext({ requestId: correlationId, correlationId }, () => {
    logger.error("startup_preflight_failed", {
      failure_code: safeErrorCode(error),
      error_fingerprint: errorFingerprint(error),
    });
  });
  if (process.env.CERP_E2E_ISOLATED === "1" && process.env.CERP_E2E_DIAGNOSTICS === "1") {
    const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`[isolated-startup-diagnostic] ${diagnostic}\n`);
  }
  process.exitCode = 1;
});
