import "dotenv/config";
import { createServer } from "http";

import pool from "./config/database";
import { assertE2EIsolation } from "./config/e2e-isolation";
import { startAuthRateLimitMaintenance } from "./module/auth/services/auth-rate-limit.service";
import { startExpiredLockMaintenance } from "./module/locks/services/locks.service";
import { startReminderMaintenance } from "./module/facturation/services/reminder-job.service";
import { createApplicationShutdown } from "./shared/runtime/application-shutdown";
import { preflightSecureUploadStorageRoots } from "./shared/uploads/secure-upload";
import { getUploadScannerStartupConfiguration } from "./shared/uploads/upload-scanner";
import { initSocketServer, shutdownRealtimeSocketServer } from "./sockets/sockeServer";

async function start(): Promise<void> {
  assertE2EIsolation();
  // Run before importing routes: several upload middlewares allocate their
  // private quarantine during module initialization.
  const uploadRoots = preflightSecureUploadStorageRoots();
  console.log(`[upload_storage] preflight ready roots=${uploadRoots.length}`);

  const [{ default: app }, uploadScanner] = await Promise.all([
    import("./config/app"),
    Promise.resolve(getUploadScannerStartupConfiguration()),
  ]);
  if (!uploadScanner.ready) {
    console.error("[upload_scan] startup degraded; enforced uploads remain blocked", {
      mode: uploadScanner.mode,
      provider: uploadScanner.provider,
      reason: uploadScanner.reason,
    });
  }

  const port = Number.parseInt(process.env.PORT || "5000", 10);
  const httpServer = createServer(app);
  const stopAuthRateLimitMaintenance = startAuthRateLimitMaintenance();
  const stopReminderMaintenance = startReminderMaintenance();

  initSocketServer(httpServer);
  const stopExpiredLockMaintenance = startExpiredLockMaintenance();

  const listenHost = process.env.CERP_E2E_ISOLATED === "1" ? "127.0.0.1" : "0.0.0.0";
  httpServer.listen(port, listenHost, () => {
    console.log(`[upload_scan] mode=${uploadScanner.mode} provider=${uploadScanner.provider} ready=${uploadScanner.ready}`);
    console.log(`Serveur CERP lance sur http://${listenHost}:${port}`);
    if (process.env.CERP_E2E_ISOLATED !== "1") {
      console.log(`Acces local prevu : http://10.90.0.2:${port}`);
    }
  });

  const configuredShutdownTimeout = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "10000", 10);
  const shutdownTimeoutMs = Number.isSafeInteger(configuredShutdownTimeout) && configuredShutdownTimeout > 0
    ? configuredShutdownTimeout
    : 10_000;
  const shutdown = createApplicationShutdown({
    httpServer,
    stopRealtime: shutdownRealtimeSocketServer,
    stopMaintenance: [stopAuthRateLimitMaintenance, stopExpiredLockMaintenance, stopReminderMaintenance],
    closeDatabase: () => pool.end(),
    log: (type, fields) => console.error(JSON.stringify({ type, ...fields })),
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
  console.error("[startup] fatal preflight failure", error);
  process.exitCode = 1;
});
