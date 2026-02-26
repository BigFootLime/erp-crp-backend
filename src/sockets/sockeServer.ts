import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { Server as SocketIOServer, type Socket } from "socket.io";

type JwtUser = {
  id: number;
  username: string;
  email: string;
  role: string;
};

let io: SocketIOServer;

const staticAllowedOrigins = new Set<string>([
  "https://crp-systems.croix-rousse-precision.fr",
  "http://crp-systems.croix-rousse-precision.fr",
  "http://localhost:5173",
  "http://localhost:5137",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5137",
  "http://127.0.0.1:4173",
]);

const envOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const o of envOrigins) staticAllowedOrigins.add(o);

function isAllowedOrigin(origin: string): boolean {
  return staticAllowedOrigins.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin);
}

function extractBearerToken(authorization: unknown): string | null {
  if (typeof authorization !== "string") return null;
  const v = authorization.trim();
  if (!v.toLowerCase().startsWith("bearer ")) return null;
  const token = v.slice("bearer ".length).trim();
  return token ? token : null;
}

function extractHandshakeToken(socket: Socket): string | null {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === "string" && auth.token.trim()) return auth.token.trim();
  const fromHeader = extractBearerToken(socket.handshake.headers.authorization);
  if (fromHeader) return fromHeader;
  return null;
}

function isValidRoom(room: string): boolean {
  if (room === "erp:global") return true;
  if (/^module:[a-z0-9][a-z0-9_-]{0,63}$/i.test(room)) return true;
  if (/^[A-Z][A-Z0-9_]*:[a-zA-Z0-9_-]{1,128}$/.test(room)) return true;
  return false;
}

export const initSocketServer = (server: HttpServer) => {
  io = new SocketIOServer(server, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) {
          const allowNoOrigin = process.env.NODE_ENV !== "production";
          cb(null, allowNoOrigin);
          return;
        }

        cb(null, isAllowedOrigin(origin) ? origin : false);
      },
      credentials: true,
      methods: ["GET", "POST"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    },
  });

  io.use((socket, next) => {
    const token = extractHandshakeToken(socket);
    if (!token) {
      next(new Error("UNAUTHORIZED"));
      return;
    }
    if (!process.env.JWT_SECRET) {
      next(new Error("SERVER_MISCONFIGURED"));
      return;
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET) as JwtUser;
      socket.data.user = decoded;
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket) => {
    socket.join("erp:global");

    socket.on("room:join", (payload: unknown, cb?: (r: { ok: boolean; error?: string }) => void) => {
      const room =
        typeof (payload as { room?: unknown } | null)?.room === "string" ? (payload as { room: string }).room.trim() : "";

      if (!room || !isValidRoom(room)) {
        cb?.({ ok: false, error: "invalid_room" });
        return;
      }

      if (socket.rooms.size >= 64) {
        cb?.({ ok: false, error: "too_many_rooms" });
        return;
      }

      socket.join(room);
      cb?.({ ok: true });
    });
  });
};

export const getIO = (): SocketIOServer => {
  if (!io) throw new Error("Socket.io n'est pas initialisé !");
  return io;
};
