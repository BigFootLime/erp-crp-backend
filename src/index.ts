import dotenv from 'dotenv';
import app from './config/app';
import { createServer } from 'http';
import { initSocketServer, shutdownRealtimeSocketServer } from './sockets/sockeServer'
import { startAuthRateLimitMaintenance } from "./module/auth/services/auth-rate-limit.service";
import { startExpiredLockMaintenance } from "./module/locks/services/locks.service";
import pool from "./config/database";
import { createApplicationShutdown } from "./shared/runtime/application-shutdown";


dotenv.config();

const PORT = parseInt(process.env.PORT || '5000', 10);

// 🛠 Serveur HTTP de base
const httpServer = createServer(app);
const stopAuthRateLimitMaintenance = startAuthRateLimitMaintenance();

// 🔌 Initialisation du serveur WebSocket
initSocketServer(httpServer);
const stopExpiredLockMaintenance = startExpiredLockMaintenance();

// 🚀 Lancement du serveur
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur CERP lancé sur http://0.0.0.0:${PORT}`);
  console.log(`🌐 Accès local prévu : http://10.90.0.2:${PORT}`);
});

const configuredShutdownTimeout = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "10000", 10);
const shutdownTimeoutMs = Number.isSafeInteger(configuredShutdownTimeout) && configuredShutdownTimeout > 0
  ? configuredShutdownTimeout
  : 10_000;
const shutdown = createApplicationShutdown({
  httpServer,
  stopRealtime: shutdownRealtimeSocketServer,
  stopMaintenance: [stopAuthRateLimitMaintenance, stopExpiredLockMaintenance],
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
