import "dotenv/config";
import { assertDeploymentSecurity } from "./config/deployment-security";
import crypto from "node:crypto";
import { createServer } from "http";

import pool from "./config/database";
import {assertManagedDatabaseAtStartup} from './config/managed-database';
import {initializeSharedDirectorySite} from './shared-directory/site-runtime';
import { assertCompanyRuntimeAtStartup } from './module/entreprises/runtime/company-runtime.service';
import { resolveCompanyBackgroundProfile, selectCompanyBackgroundStarters } from './module/entreprises/runtime/company-background-profile';
import { startIntercompanyDeliveryMaintenance } from './module/entreprises/intercompany/intercompany-worker';
import { intercompanyTransportConfiguration } from './module/entreprises/intercompany/intercompany-transport';
import { assertE2EIsolation } from "./config/e2e-isolation";
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
import { startBackgroundLifecycle } from "./shared/runtime/background-lifecycle";
import { runtimeListenHost } from "./shared/runtime/runtime-listen-host";
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
  await assertCompanyRuntimeAtStartup(pool);
  const companyBackgroundProfile = await resolveCompanyBackgroundProfile();
  intercompanyTransportConfiguration();
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
  const backgroundLifecycle = startBackgroundLifecycle({
    pool,
    starters: selectCompanyBackgroundStarters(companyBackgroundProfile, [
      { key: "auth-rate-limit", start: startAuthRateLimitMaintenance },
      { key: "mfa", start: startMfaArtifactMaintenance },
      { key: "locks", start: startExpiredLockMaintenance },
      { key: "reminders", start: startReminderMaintenance },
      { key: "electronic-invoices", start: startElectronicInvoiceMaintenance },
      { key: "supplier-invoices", start: startSupplierInvoiceMaintenance },
      { key: "e-reporting", start: startEReportingMaintenance },
      { key: "webhooks", start: startWebhookDeliveryMaintenance },
      { key: "authoritative-documents", start: startAuthoritativePdfArchiveMaintenance },
      { key: "planning-forecast", start: startPlanningForecastMaintenance },
      { key: "duration-learning", start: startDurationLearningMaintenance },
      { key: "cump-projection", start: startCumpProjectionMaintenance },
      ...(companyBackgroundProfile === "LEGACY" ? [] : [{ key: "intercompany-delivery", start: startIntercompanyDeliveryMaintenance }]),
    ]),
  });

  initSocketServer(httpServer);

  const listenHost = runtimeListenHost(backgroundLifecycle.mode);
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
    stopMaintenance: [backgroundLifecycle.stop],
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
