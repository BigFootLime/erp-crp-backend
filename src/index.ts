import "dotenv/config";
import crypto from "node:crypto";
import { createServer } from "http";

import pool from "./config/database";
import { assertE2EIsolation, e2eListenHost } from "./config/e2e-isolation";
import { assertMfaStartupConfiguration } from "./module/auth/domain/mfa";
import { startAuthRateLimitMaintenance } from "./module/auth/services/auth-rate-limit.service";
import { startMfaArtifactMaintenance } from "./module/auth/services/mfa.service";
import { startExpiredLockMaintenance } from "./module/locks/services/locks.service";
import { startReminderMaintenance } from "./module/facturation/services/reminder-job.service";
import { startElectronicInvoiceMaintenance } from "./module/facturation/electronic-invoicing/electronic-invoice.service";
import { startWebhookDeliveryMaintenance } from "./module/integrations/webhooks/webhook.service";
import { startAuthoritativePdfArchiveMaintenance } from "./shared/authoritative-documents/authoritative-document.worker";
import { createApplicationShutdown } from "./shared/runtime/application-shutdown";
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
  assertMfaStartupConfiguration();
  // Run the GED identity/RW proof before the generic upload-root preflight:
  // otherwise a missing mount could be replaced by a newly created directory
  // on the system disk before the sentinel has been checked.
  const criticalStorage = await preflightCriticalStorageAtStartup();
  logger.info("critical_storage_preflight_succeeded", criticalStorage);
  // Run before importing routes: several upload middlewares allocate their
  // private quarantine during module initialization.
  const uploadRoots = preflightSecureUploadStorageRoots();
  logger.info("upload_storage_preflight_succeeded", { root_count: uploadRoots.length });

  const [{ default: app }, uploadScanner] = await Promise.all([
    import("./config/app"),
    Promise.resolve(getUploadScannerStartupConfiguration()),
  ]);
  setScannerStartupState(uploadScanner);
  if (!uploadScanner.ready) {
    logger.error("upload_scanner_degraded", {
      mode: uploadScanner.mode,
      provider: uploadScanner.provider,
      reason_code: uploadScanner.reason,
      affected_scope: "file_uploads",
    });
  }

  const port = Number.parseInt(process.env.PORT || "5000", 10);
  const httpServer = createServer(app);
  const stopAuthRateLimitMaintenance = startAuthRateLimitMaintenance();
  const stopMfaArtifactMaintenance = startMfaArtifactMaintenance();
  const stopReminderMaintenance = startReminderMaintenance();
  const stopElectronicInvoiceMaintenance = startElectronicInvoiceMaintenance();
  const stopWebhookDeliveryMaintenance = startWebhookDeliveryMaintenance();
  const stopAuthoritativePdfArchiveMaintenance = startAuthoritativePdfArchiveMaintenance();

  initSocketServer(httpServer);
  const stopExpiredLockMaintenance = startExpiredLockMaintenance();

  const listenHost = e2eListenHost();
  httpServer.listen(port, listenHost, () => {
    logger.info("upload_scanner_initialized", {
      mode: uploadScanner.mode,
      provider: uploadScanner.provider,
      ready: uploadScanner.ready,
    });
    logger.info("service_listening", { listen_host: listenHost, listen_port: port });
  });

  const configuredShutdownTimeout = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "10000", 10);
  const shutdownTimeoutMs = Number.isSafeInteger(configuredShutdownTimeout) && configuredShutdownTimeout > 0
    ? configuredShutdownTimeout
    : 10_000;
  const shutdown = createApplicationShutdown({
    httpServer,
    stopRealtime: shutdownRealtimeSocketServer,
    stopMaintenance: [
      stopAuthRateLimitMaintenance,
      stopMfaArtifactMaintenance,
      stopExpiredLockMaintenance,
      stopReminderMaintenance,
      stopElectronicInvoiceMaintenance,
      stopWebhookDeliveryMaintenance,
      stopAuthoritativePdfArchiveMaintenance,
    ],
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
  httpServer.once("close", () => terminate("HTTP_CLOSE"));
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
