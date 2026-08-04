import type { Server as HttpServer } from "http";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { Server as SocketIOServer, type Socket } from "socket.io";

import { resolveAccessProfile } from "../module/access-control/services/access-control.service";
import {
  canSubscribeStationRoom,
  parseStationRoom,
  type StationRoom,
} from "../module/production/domain/station";
import {
  repoStationAudit,
  repoUserRealtimeScope,
} from "../module/production/repository/station.repository";
import {
  repoRealtimeAccountAuthorization,
  type RealtimeAccountAuthorization,
} from "../shared/realtime/realtime-authorization.repository";
import {
  REALTIME_CAPABILITIES,
  moduleForRealtimeEntity,
  normalizeClientRealtimeSubscription,
  realtimeRoomName,
  stationLegacyRoom,
  type ClientRealtimeSubscription,
  type RealtimeSubscription,
} from "../shared/realtime/realtime-room-policy";

type JwtUser = {
  id: number;
  username?: string;
  email?: string;
  role: string;
  primary_role?: string;
  roles?: string[];
  exp?: number;
  iat?: number;
};

type RoomAck = { ok: boolean; error?: "invalid_subscription" | "forbidden" | "too_many_rooms" };

export type SocketAuthorizationDependencies = {
  loadAccountAuthorization: (userId: number) => Promise<RealtimeAccountAuthorization | null>;
  resolveAccountAccessProfile: typeof resolveAccessProfile;
  authorizeStationSubscription: (subscription: Extract<ClientRealtimeSubscription, { scope: "station" }>, user: JwtUser) => Promise<boolean>;
};

export type RealtimeSecurityMetrics = {
  connectionsDenied: number;
  subscriptionsAllowed: number;
  subscriptionsDenied: number;
  emissionsDelivered: number;
  emissionRecipientsDenied: number;
  invalidEmissionTargets: number;
  expiredSessionsDisconnected: number;
};

let io: SocketIOServer | undefined;
let authorizationDependencies: SocketAuthorizationDependencies;

const CHAT_PRESENCE_SNAPSHOT_EVENT = "chat:presence:snapshot";
const CHAT_USER_PRESENCE_EVENT = "chat:user:presence";
const onlineUserCounts = new Map<number, number>();
const revokedBeforeOrAt = new Map<number, number>();
const revokedTokenDigests = new Map<string, number>();
const expiryTimers = new Map<string, NodeJS.Timeout>();
const metrics: RealtimeSecurityMetrics = {
  connectionsDenied: 0,
  subscriptionsAllowed: 0,
  subscriptionsDenied: 0,
  emissionsDelivered: 0,
  emissionRecipientsDenied: 0,
  invalidEmissionTargets: 0,
  expiredSessionsDisconnected: 0,
};

function resetRuntimeState(): void {
  onlineUserCounts.clear();
  for (const timer of expiryTimers.values()) clearTimeout(timer);
  expiryTimers.clear();
  for (const key of Object.keys(metrics) as Array<keyof RealtimeSecurityMetrics>) metrics[key] = 0;
}

function logAclDenied(reason: string, scope: string): void {
  console.warn(JSON.stringify({ type: "realtime_acl_denied", reason, scope }));
}

function nowIso(): string {
  return new Date().toISOString();
}

function listOnlineUserIds(): number[] {
  const ids: number[] = [];
  for (const [id, count] of onlineUserCounts.entries()) {
    if (count > 0) ids.push(id);
  }
  ids.sort((a, b) => a - b);
  return ids;
}

const staticAllowedOrigins = new Set<string>([
  "https://cerp.croix-rousse-precision.fr",
  "http://cerp.croix-rousse-precision.fr",
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

for (const origin of envOrigins) staticAllowedOrigins.add(origin);

function isAllowedOrigin(origin: string): boolean {
  return staticAllowedOrigins.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin);
}

function extractBearerToken(authorization: unknown): string | null {
  if (typeof authorization !== "string") return null;
  const value = authorization.trim();
  if (!value.toLowerCase().startsWith("bearer ")) return null;
  const token = value.slice("bearer ".length).trim();
  return token || null;
}

function extractHandshakeToken(socket: Socket): string | null {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === "string" && auth.token.trim()) return auth.token.trim();
  return extractBearerToken(socket.handshake.headers.authorization);
}

function validUserId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function purgeExpiredTokenDigests(): void {
  const now = Date.now();
  for (const [digest, expiresAt] of revokedTokenDigests) {
    if (expiresAt <= now) revokedTokenDigests.delete(digest);
  }
}

function tokenDigest(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function tokenIsRevoked(user: JwtUser, digest?: string): boolean {
  purgeExpiredTokenDigests();
  if (digest && revokedTokenDigests.has(digest)) return true;
  const cutoff = revokedBeforeOrAt.get(user.id);
  return cutoff !== undefined && (user.iat ?? 0) < cutoff;
}

function tokenIsExpired(user: JwtUser): boolean {
  return typeof user.exp === "number" && user.exp * 1000 <= Date.now();
}

function currentJwtUser(socket: Socket): JwtUser | null {
  const user = socket.data.user as JwtUser | undefined;
  return user && validUserId(user.id) ? user : null;
}

function applyCurrentAuthorization(user: JwtUser, account: RealtimeAccountAuthorization): void {
  user.role = account.role;
  user.primary_role = account.primaryRole;
  user.roles = account.roles;
}

async function defaultAuthorizeStationSubscription(
  subscription: Extract<ClientRealtimeSubscription, { scope: "station" }>,
  user: JwtUser
): Promise<boolean> {
  const room = parseStationRoom(stationLegacyRoom(subscription));
  if (!room || room.kind === "USER") return false;
  return authorizeStationRoom(room, user);
}

/**
 * The station scope remains server-derived from live assignments. A denial is
 * stored in the station audit trail; console logs intentionally contain no ID.
 */
async function authorizeStationRoom(room: StationRoom, user: JwtUser): Promise<boolean> {
  const scope = await repoUserRealtimeScope(user.id);
  const allowed = canSubscribeStationRoom({
    room,
    actorUserId: user.id,
    actorRole: user.role ?? null,
    ownMachineIds: scope.machineIds,
    ownOfIds: scope.ofIds,
    ownDeviceIds: scope.deviceIds,
  });

  if (!allowed) {
    void repoStationAudit({
      event_type: "ROOM_SUBSCRIPTION_DENIED",
      outcome: "DENIED",
      reason_code: room.kind,
      user_id: user.id,
      machine_id: room.kind === "MACHINE" ? room.machineId : null,
      of_id: room.kind === "OF" ? room.ofId : null,
      device_id: room.kind === "STATION" ? room.deviceId : null,
    });
  }

  return allowed;
}

async function authorizeSubscription(
  socket: Socket,
  subscription: RealtimeSubscription,
  accountOverride?: RealtimeAccountAuthorization | null
): Promise<boolean> {
  const user = currentJwtUser(socket);
  const digest = typeof socket.data.tokenDigest === "string" ? socket.data.tokenDigest : undefined;
  if (!user || tokenIsExpired(user) || tokenIsRevoked(user, digest)) return false;

  const account = accountOverride === undefined
    ? await authorizationDependencies.loadAccountAuthorization(user.id)
    : accountOverride;
  if (!account?.active) return false;
  applyCurrentAuthorization(user, account);

  if (subscription.scope === "user") return subscription.userId === user.id;
  if (subscription.scope === "capability") {
    if (subscription.capability === REALTIME_CAPABILITIES.CHAT_PRESENCE) return true;
    if (subscription.capability === REALTIME_CAPABILITIES.AUDIT_READ) {
      const profile = await authorizationDependencies.resolveAccountAccessProfile(user.id);
      return profile?.is_superadmin === true;
    }
    return false;
  }
  if (subscription.scope === "station") {
    return authorizationDependencies.authorizeStationSubscription(subscription, user);
  }

  const moduleKey = subscription.scope === "module"
    ? subscription.moduleKey
    : moduleForRealtimeEntity(subscription.entityType);
  if (!moduleKey) return false;
  const profile = await authorizationDependencies.resolveAccountAccessProfile(user.id);
  if (!profile) return false;
  return profile.is_superadmin || profile.modules.some((entry) => entry.module_key === moduleKey && entry.allowed);
}

function scheduleExpiryDisconnect(socket: Socket): void {
  const user = currentJwtUser(socket);
  if (!user || typeof user.exp !== "number") return;
  const delay = Math.max(0, user.exp * 1000 - Date.now());
  const timer = setTimeout(() => {
    expiryTimers.delete(socket.id);
    metrics.expiredSessionsDisconnected += 1;
    socket.disconnect(true);
  }, Math.min(delay, 2_147_483_647));
  expiryTimers.set(socket.id, timer);
}

async function joinAuthorized(socket: Socket, subscription: RealtimeSubscription): Promise<boolean> {
  if (!(await authorizeSubscription(socket, subscription))) return false;
  await socket.join(realtimeRoomName(subscription));
  return true;
}

async function emitPresenceDelta(userId: number, online: boolean): Promise<void> {
  await emitToAuthorizedSubscribers(
    CHAT_USER_PRESENCE_EVENT,
    { user_id: userId, online, at: nowIso() },
    [{ scope: "capability", capability: REALTIME_CAPABILITIES.CHAT_PRESENCE }]
  );
}

export const initSocketServer = (
  server: HttpServer,
  overrides: Partial<SocketAuthorizationDependencies> = {}
): SocketIOServer => {
  resetRuntimeState();
  authorizationDependencies = {
    loadAccountAuthorization: repoRealtimeAccountAuthorization,
    resolveAccountAccessProfile: resolveAccessProfile,
    authorizeStationSubscription: defaultAuthorizeStationSubscription,
    ...overrides,
  };

  io = new SocketIOServer(server, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) {
          cb(null, process.env.NODE_ENV !== "production");
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
    void (async () => {
      const token = extractHandshakeToken(socket);
      if (!token) throw new Error("UNAUTHORIZED");
      if (!process.env.JWT_SECRET) throw new Error("SERVER_MISCONFIGURED");

      const decoded = jwt.verify(token, process.env.JWT_SECRET) as JwtUser;
      const digest = tokenDigest(token);
      if (!validUserId(decoded.id) || typeof decoded.exp !== "number" || tokenIsRevoked(decoded, digest)) {
        throw new Error("UNAUTHORIZED");
      }
      const account = await authorizationDependencies.loadAccountAuthorization(decoded.id);
      if (!account?.active) throw new Error("UNAUTHORIZED");
      applyCurrentAuthorization(decoded, account);
      socket.data.user = decoded;
      socket.data.tokenDigest = digest;
      next();
    })().catch((error: unknown) => {
      metrics.connectionsDenied += 1;
      const code = error instanceof Error && error.message === "SERVER_MISCONFIGURED"
        ? "SERVER_MISCONFIGURED"
        : "UNAUTHORIZED";
      logAclDenied(code.toLowerCase(), "connection");
      next(new Error(code));
    });
  });

  io.on("connection", (socket) => {
    const user = currentJwtUser(socket);
    if (!user) {
      socket.disconnect(true);
      return;
    }
    let countedOnline = false;

    socket.on("room:subscribe", (payload: unknown, callback?: (result: RoomAck) => void) => {
      void (async () => {
        const subscription = normalizeClientRealtimeSubscription(payload);
        if (!subscription) {
          metrics.subscriptionsDenied += 1;
          logAclDenied("invalid_subscription", "unknown");
          callback?.({ ok: false, error: "invalid_subscription" });
          return;
        }
        if (socket.rooms.size >= 64) {
          metrics.subscriptionsDenied += 1;
          callback?.({ ok: false, error: "too_many_rooms" });
          return;
        }
        if (!(await joinAuthorized(socket, subscription))) {
          metrics.subscriptionsDenied += 1;
          logAclDenied("forbidden", subscription.scope);
          callback?.({ ok: false, error: "forbidden" });
          return;
        }
        metrics.subscriptionsAllowed += 1;
        callback?.({ ok: true });
      })().catch(() => {
        metrics.subscriptionsDenied += 1;
        logAclDenied("authorization_error", "unknown");
        callback?.({ ok: false, error: "forbidden" });
      });
    });

    socket.on("room:unsubscribe", (payload: unknown, callback?: (result: RoomAck) => void) => {
      const subscription = normalizeClientRealtimeSubscription(payload);
      if (!subscription) {
        callback?.({ ok: false, error: "invalid_subscription" });
        return;
      }
      void socket.leave(realtimeRoomName(subscription));
      callback?.({ ok: true });
    });

    socket.on("disconnect", () => {
      const timer = expiryTimers.get(socket.id);
      if (timer) clearTimeout(timer);
      expiryTimers.delete(socket.id);
      if (!countedOnline) return;
      const current = onlineUserCounts.get(user.id) ?? 0;
      if (current <= 1) {
        onlineUserCounts.delete(user.id);
        void emitPresenceDelta(user.id, false);
      } else {
        onlineUserCounts.set(user.id, current - 1);
      }
    });

    void (async () => {
      scheduleExpiryDisconnect(socket);
      await Promise.all([
        joinAuthorized(socket, { scope: "user", userId: user.id }),
        joinAuthorized(socket, { scope: "capability", capability: REALTIME_CAPABILITIES.CHAT_PRESENCE }),
        joinAuthorized(socket, { scope: "capability", capability: REALTIME_CAPABILITIES.AUDIT_READ }),
      ]);
      if (!socket.connected) return;
      const previous = onlineUserCounts.get(user.id) ?? 0;
      onlineUserCounts.set(user.id, previous + 1);
      countedOnline = true;
      socket.emit(CHAT_PRESENCE_SNAPSHOT_EVENT, { online_user_ids: listOnlineUserIds(), at: nowIso() });
      if (previous === 0) await emitPresenceDelta(user.id, true);
    })().catch(() => {
      logAclDenied("connection_setup_failed", "connection");
      socket.disconnect(true);
    });
  });

  return io;
};

/**
 * Sends once per local socket after reloading mutable account authorization.
 * The target list is a union, preventing duplicate delivery to a socket that
 * subscribed to both an entity and its module.
 */
export async function emitToAuthorizedSubscribers(
  event: string,
  payload: unknown,
  targets: readonly RealtimeSubscription[]
): Promise<void> {
  if (!io || targets.length === 0) {
    metrics.invalidEmissionTargets += 1;
    logAclDenied("missing_target", "emission");
    return;
  }

  const uniqueTargets = [...new Map(targets.map((target) => [realtimeRoomName(target), target])).values()];
  const accountLoads = new Map<number, Promise<RealtimeAccountAuthorization | null>>();

  for (const socket of io.sockets.sockets.values()) {
    const matching = uniqueTargets.filter((target) => socket.rooms.has(realtimeRoomName(target)));
    if (matching.length === 0) continue;
    const user = currentJwtUser(socket);
    if (!user) continue;
    let accountLoad = accountLoads.get(user.id);
    if (!accountLoad) {
      accountLoad = authorizationDependencies.loadAccountAuthorization(user.id);
      accountLoads.set(user.id, accountLoad);
    }
    const account = await accountLoad;
    let allowed = false;
    for (const target of matching) {
      if (await authorizeSubscription(socket, target, account)) {
        allowed = true;
      } else {
        metrics.emissionRecipientsDenied += 1;
        await socket.leave(realtimeRoomName(target));
      }
    }
    if (allowed) {
      socket.emit(event, payload);
      metrics.emissionsDelivered += 1;
    }
  }
}

export function revokeUserRealtimeSessions(userId: number): void {
  if (!validUserId(userId)) return;
  revokedBeforeOrAt.set(userId, Math.floor(Date.now() / 1000));
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    const user = currentJwtUser(socket);
    if (user?.id !== userId) continue;
    const digest = typeof socket.data.tokenDigest === "string" ? socket.data.tokenDigest : null;
    if (digest) revokedTokenDigests.set(digest, (user.exp ?? Math.floor(Date.now() / 1000) + 86_400) * 1000);
    socket.disconnect(true);
  }
}

export function getRealtimeSecurityMetrics(): Readonly<RealtimeSecurityMetrics> {
  return { ...metrics };
}

export const getIO = (): SocketIOServer => {
  if (!io) throw new Error("Socket.io n'est pas initialisé !");
  return io;
};
