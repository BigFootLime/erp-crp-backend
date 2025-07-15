import dotenv from 'dotenv';
import app from './config/app';
import { createServer } from 'http';
import { initSocketServer } from '../src/sockets/sockeServer';

dotenv.config();

const PORT = parseInt(process.env.PORT || '5000', 10);

// 🛠 Serveur HTTP de base
const httpServer = createServer(app);

// 🔌 Initialisation du serveur WebSocket
initSocketServer(httpServer);

// 🚀 Lancement du serveur
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur ERP lancé sur http://0.0.0.0:${PORT}`);
  console.log(`🌐 Accès depuis le réseau : http://82.25.112.61:${PORT}`);
});
