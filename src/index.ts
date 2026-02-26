import dotenv from 'dotenv';
import app from './config/app';
import { createServer } from 'http';
import { initSocketServer } from './sockets/sockeServer'
import { startAuditNotifyListener } from "./shared/realtime/audit-notify.listener";


dotenv.config();

const PORT = parseInt(process.env.PORT || '5000', 10);

// 🛠 Serveur HTTP de base
const httpServer = createServer(app);

// 🔌 Initialisation du serveur WebSocket
initSocketServer(httpServer);

// 📣 Realtime: audit:new listener (Postgres NOTIFY)
startAuditNotifyListener().catch((err) => {
  console.error("[audit_notify] failed to start", err);
});

// 🚀 Lancement du serveur
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur ERP lancé sur http://0.0.0.0:${PORT}`);
  console.log(`🌐 Accès depuis le réseau : http://erp-backend.croix-rousse-precision.fr:8080`);
});
