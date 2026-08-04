import 'dotenv/config';
import { createServer } from 'http';
import { initSocketServer } from './sockets/sockeServer'
import { startAuditNotifyListener } from "./shared/realtime/audit-notify.listener";
import { preflightSecureUploadStorageRoots } from "./shared/uploads/secure-upload";
import { getUploadScannerStartupConfiguration } from "./shared/uploads/upload-scanner";
import { startAuthRateLimitMaintenance } from "./module/auth/services/auth-rate-limit.service";

async function start(): Promise<void> {
  // Run before importing routes: several upload middlewares allocate their
  // private quarantine during module initialization.
  const uploadRoots = preflightSecureUploadStorageRoots();
  console.log(`[upload_storage] preflight ready roots=${uploadRoots.length}`);

  const [{ default: app }, uploadScanner] = await Promise.all([
    import('./config/app'),
    Promise.resolve(getUploadScannerStartupConfiguration()),
  ]);
  if (!uploadScanner.ready) {
    console.error("[upload_scan] startup degraded; enforced uploads remain blocked", {
      mode: uploadScanner.mode,
      provider: uploadScanner.provider,
      reason: uploadScanner.reason,
    });
  }

  const port = parseInt(process.env.PORT || '5000', 10);
  const httpServer = createServer(app);
  const stopAuthRateLimitMaintenance = startAuthRateLimitMaintenance();
  httpServer.on("close", stopAuthRateLimitMaintenance);

  initSocketServer(httpServer);
  startAuditNotifyListener().catch((err) => {
    console.error("[audit_notify] failed to start", err);
  });

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`[upload_scan] mode=${uploadScanner.mode} provider=${uploadScanner.provider} ready=${uploadScanner.ready}`);
    console.log(`🚀 Serveur CERP lancé sur http://0.0.0.0:${port}`);
    console.log(`🌐 Accès local prévu : http://10.90.0.2:${port}`);
  });
}

void start().catch((error) => {
  console.error("[startup] fatal preflight failure", error);
  process.exitCode = 1;
});
