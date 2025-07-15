import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer;

export const initSocketServer = (server: HttpServer) => {
  io = new SocketIOServer(server, {
    cors: {
      origin: '*', // 🔐 sécurise en prod (ex: ['http://localhost:5173'])
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    console.log(`🧠 Nouveau client connecté : ${socket.id}`);

    socket.on('disconnect', () => {
      console.log(`❌ Client déconnecté : ${socket.id}`);
    });
  });
};

export const getIO = (): SocketIOServer => {
  if (!io) throw new Error("Socket.io n'est pas initialisé !");
  return io;
};
