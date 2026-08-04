import type { Server as HttpServer } from "http";
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
  PostgresRealtimeControlPlane,
  type PublishRealtimeEventInput,
  type RealtimeControlPlane,
  type RealtimeControlSignal,
  type RealtimeEventRecord,
} from "../shared/realtime/realtime-control-plane";
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
  jti?: string;
  session_epoch?: number;
};

type RoomAck = { ok: boolean; error?: "invalid_subscription" | "forbidden" | "too_many_rooms" };
type ResumeAck = {
  ok: boolean;
  error?: "invalid_cursor" | "forbidden" | "replay_failed";
  lastSequence?: string;
  truncated?: boolean;
};

export type SocketAuthorizationDependencies = {
  loadAccountAuthorization: (userId: number) => Promise<RealtimeAccountAuthorization | null>;
  resolveAccountAccessProfile: typeof resolveAccessProfile;
  authorizeStationSubscription: (
    subscription: Extract<ClientRealtimeSubscription, { scope: "station" }>,
    user: JwtUser
  ) => Promise<boolean>;
};

export type RealtimeSecurityMetrics = {
  connectionsDenied: number;
  subscriptionsAllowed: number;
  subscriptionsDenied: number;
  eventsPublished: number;
  publishFailures: number;
  emissionsDelivered: number;
  emissionRecipientsDenied: number;
  invalidEmissionTargets: number;
  expiredSessionsDisconnected: number;
  revokedSessionsDisconnected: number;
  recipientDispatchErrors: number;
  deliveryBatchesWithoutRecipients: number;
  duplicateEventsSkipped: number;
  replayEventsDelivered: number;
  controlPlanePollFailures: number;
};

export type RealtimeRuntimeOptions = {
  controlPlane?: RealtimeControlPlane;
  pollIntervalMs?: number;
  sessionRevalidationMs?: number;
  pruneIntervalMs?: number;
};

export type PublishRealtimeOptions = {
  streamId?: string;
  deduplicationKey?: string;
};

const CHAT_PRESENCE_SNAPSHOT_EVENT = "chat:presence:snapshot";
const CHAT_USER_PRESENCE_EVENT = "chat:user:presence";
const MAX_SOCKET_ROOMS = 64;
const MAX_DELIVERED_EVENT_IDS = 2_048;
const MAX_REPLAY_EVENTS = 2_000;
const EVENT_READ_BATCH = 500;

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

for (const origin of (process.env.CORS_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
  staticAllowedOrigins.add(origin);
}

function createMetrics(): RealtimeSecurityMetrics {
  return {
    connectionsDenied: 0,
    subscriptionsAllowed: 0,
    subscriptionsDenied: 0,
    eventsPublished: 0,
    publishFailures: 0,
    emissionsDelivered: 0,
    emissionRecipientsDenied: 0,
    invalidEmissionTargets: 0,
    expiredSessionsDisconnected: 0,
    revokedSessionsDisconnected: 0,
    recipientDispatchErrors: 0,
    deliveryBatchesWithoutRecipients: 0,
    duplicateEventsSkipped: 0,
    replayEventsDelivered: 0,
    controlPlanePollFailures: 0,
  };
}

function logSecurityEvent(type: string, fields: Record<string, string | number | boolean>): void {
  console.warn(JSON.stringify({ type, ...fields }));
}

function nowIso(): string {
  return new Date().toISOString();
}

function isAllowedOrigin(origin: string): boolean {
  return staticAllowedOrigins.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin);
}

function extractBearerToken(authorization: unknown): string | null {
  if (typeof authorization !== "string") return null;
  const value = authorization.trim();
  if (!value.toLowerCase().startsWith("bearer ")) return null;
  return value.slice("bearer ".length).trim() || null;
}

function extractHandshakeToken(socket: Socket): string | null {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === "string" && auth.token.trim()) return auth.token.trim();
  return extractBearerToken(socket.handshake.headers.authorization);
}

function validUserId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validSessionEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function tokenSessionEpoch(user: JwtUser): number {
  return validSessionEpoch(user.session_epoch) ? user.session_epoch : 0;
}

function tokenMatchesAccount(user: JwtUser, account: RealtimeAccountAuthorization): boolean {
  if (tokenSessionEpoch(user) !== account.sessionEpoch) return false;
  // Rolling compatibility: legacy tokens are accepted only before the first
  // durable epoch bump. Every post-migration token carries a signed UUID jti.
  if (account.sessionEpoch > 0 && (typeof user.jti !== "string" || !/^[0-9a-f-]{36}$/i.test(user.jti))) return false;
  return true;
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

function parseResumeCursor(value: unknown): bigint | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "afterSequence") return null;
  const cursor = (value as { afterSequence?: unknown }).afterSequence;
  if (typeof cursor !== "string" || !/^\d{1,20}$/.test(cursor)) return null;
  try {
    const parsed = BigInt(cursor);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalStoredTarget(target: RealtimeSubscription): RealtimeSubscription | null {
  if (target.scope === "user") return validUserId(target.userId) ? target : null;
  if (target.scope === "capability") {
    return target.capability === REALTIME_CAPABILITIES.AUDIT_READ
      || target.capability === REALTIME_CAPABILITIES.CHAT_PRESENCE
      ? target
      : null;
  }
  return normalizeClientRealtimeSubscription(target);
}

function deriveStreamId(event: string, targets: readonly RealtimeSubscription[]): string {
  const entity = targets.find((target) => target.scope === "entity");
  if (entity?.scope === "entity") return `entity:${entity.entityType}:${entity.entityId}`;
  const first = targets[0];
  return first ? realtimeRoomName(first) : `invalid:${event}`;
}

function decoratedPayload(record: RealtimeEventRecord): Record<string, unknown> {
  const base = typeof record.payload === "object" && record.payload !== null && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : { value: record.payload };
  return {
    ...base,
    event_id: record.eventId,
    sequence: record.sequence.toString(),
    stream_id: record.streamId,
    occurred_at: record.occurredAt,
  };
}

async function defaultAuthorizeStationSubscription(
  subscription: Extract<ClientRealtimeSubscription, { scope: "station" }>,
  user: JwtUser
): Promise<boolean> {
  const room = parseStationRoom(stationLegacyRoom(subscription));
  if (!room || room.kind === "USER") return false;
  return authorizeStationRoom(room, user);
}

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

export class RealtimeSocketRuntime {
  readonly io: SocketIOServer;
  private readonly dependencies: SocketAuthorizationDependencies;
  private readonly controlPlane: RealtimeControlPlane;
  private readonly metrics = createMetrics();
  private readonly onlineUserCounts = new Map<number, number>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly streamQueues = new Map<string, Promise<void>>();
  private readonly pollIntervalMs: number;
  private readonly sessionRevalidationMs: number;
  private readonly pruneIntervalMs: number;
  private cursor = 0n;
  private drainPromise: Promise<void> | null = null;
  private drainAgain = false;
  private startPromise: Promise<void> | null = null;
  private stopListener: (() => Promise<void>) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private revalidationTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    server: HttpServer,
    overrides: Partial<SocketAuthorizationDependencies> = {},
    options: RealtimeRuntimeOptions = {}
  ) {
    this.dependencies = {
      loadAccountAuthorization: repoRealtimeAccountAuthorization,
      resolveAccountAccessProfile: resolveAccessProfile,
      authorizeStationSubscription: defaultAuthorizeStationSubscription,
      ...overrides,
    };
    this.controlPlane = options.controlPlane ?? new PostgresRealtimeControlPlane();
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.sessionRevalidationMs = options.sessionRevalidationMs ?? 2_000;
    this.pruneIntervalMs = options.pruneIntervalMs ?? 60_000;
    this.io = new SocketIOServer(server, {
      cors: {
        origin: (origin, callback) => {
          if (!origin) {
            callback(null, process.env.NODE_ENV !== "production");
            return;
          }
          callback(null, isAllowedOrigin(origin) ? origin : false);
        },
        credentials: true,
        methods: ["GET", "POST"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      },
    });
    this.installSocketHandlers();
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      this.cursor = await this.controlPlane.latestSequence();
      try {
        this.stopListener = await this.controlPlane.subscribe((signal) => this.onControlSignal(signal));
      } catch (error) {
        this.metrics.controlPlanePollFailures += 1;
        logSecurityEvent("realtime_control_listener_start_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
      this.pollTimer = setInterval(() => void this.requestDrain(), this.pollIntervalMs);
      this.revalidationTimer = setInterval(() => void this.revalidateConnectedSessions(), this.sessionRevalidationMs);
      this.pruneTimer = setInterval(() => {
        void this.controlPlane.pruneExpired().catch((error: unknown) => {
          this.metrics.controlPlanePollFailures += 1;
          logSecurityEvent("realtime_retention_prune_failed", {
            error: error instanceof Error ? error.name : "unknown",
          });
        });
      }, this.pruneIntervalMs);
      this.pollTimer.unref();
      this.revalidationTimer.unref();
      this.pruneTimer.unref();
    })();
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.revalidationTimer) clearInterval(this.revalidationTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    await this.stopListener?.();
    this.stopListener = null;
  }

  getMetrics(): Readonly<RealtimeSecurityMetrics> {
    return { ...this.metrics };
  }

  async publish(
    event: string,
    payload: unknown,
    targets: readonly RealtimeSubscription[],
    options: PublishRealtimeOptions = {}
  ): Promise<RealtimeEventRecord> {
    await this.start();
    const canonicalTargets = targets.map(canonicalStoredTarget);
    if (
      !/^[a-zA-Z][a-zA-Z0-9:_-]{0,127}$/.test(event)
      || canonicalTargets.length === 0
      || canonicalTargets.some((target) => !target)
    ) {
      this.metrics.invalidEmissionTargets += 1;
      logSecurityEvent("realtime_publish_denied", { reason: "invalid_target", event });
      throw new Error("INVALID_REALTIME_TARGET");
    }
    const input: PublishRealtimeEventInput = {
      event,
      payload,
      targets: canonicalTargets as RealtimeSubscription[],
      streamId: options.streamId ?? deriveStreamId(event, canonicalTargets as RealtimeSubscription[]),
      deduplicationKey: options.deduplicationKey,
    };
    try {
      const stored = await this.controlPlane.publish(input);
      this.metrics.eventsPublished += 1;
      void this.requestDrain();
      return stored;
    } catch (error) {
      this.metrics.publishFailures += 1;
      logSecurityEvent("realtime_publish_rejected", {
        event,
        error: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }

  async revokeUser(userId: number, durable = true): Promise<void> {
    if (!validUserId(userId)) return;
    await this.start();
    if (durable) await this.controlPlane.revokeSessions(userId);
    await this.disconnectUser(userId);
  }

  private installSocketHandlers(): void {
    this.io.use((socket, next) => {
      void (async () => {
        await this.start();
        const token = extractHandshakeToken(socket);
        if (!token) throw new Error("UNAUTHORIZED");
        if (!process.env.JWT_SECRET) throw new Error("SERVER_MISCONFIGURED");
        const decoded = jwt.verify(token, process.env.JWT_SECRET) as JwtUser;
        if (!validUserId(decoded.id) || typeof decoded.exp !== "number" || tokenIsExpired(decoded)) {
          throw new Error("UNAUTHORIZED");
        }
        const account = await this.dependencies.loadAccountAuthorization(decoded.id);
        if (!account?.active || !tokenMatchesAccount(decoded, account)) throw new Error("UNAUTHORIZED");
        applyCurrentAuthorization(decoded, account);
        socket.data.user = decoded;
        socket.data.deliveredRealtimeEventIds = new Map<string, true>();
        next();
      })().catch((error: unknown) => {
        this.metrics.connectionsDenied += 1;
        const code = error instanceof Error && error.message === "SERVER_MISCONFIGURED"
          ? "SERVER_MISCONFIGURED"
          : "UNAUTHORIZED";
        logSecurityEvent("realtime_acl_denied", { reason: code.toLowerCase(), scope: "connection" });
        next(new Error(code));
      });
    });

    this.io.on("connection", (socket) => this.onConnection(socket));
  }

  private onConnection(socket: Socket): void {
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
          this.metrics.subscriptionsDenied += 1;
          logSecurityEvent("realtime_acl_denied", { reason: "invalid_subscription", scope: "unknown" });
          callback?.({ ok: false, error: "invalid_subscription" });
          return;
        }
        if (socket.rooms.size >= MAX_SOCKET_ROOMS) {
          this.metrics.subscriptionsDenied += 1;
          callback?.({ ok: false, error: "too_many_rooms" });
          return;
        }
        if (!(await this.joinAuthorized(socket, subscription))) {
          this.metrics.subscriptionsDenied += 1;
          logSecurityEvent("realtime_acl_denied", { reason: "forbidden", scope: subscription.scope });
          callback?.({ ok: false, error: "forbidden" });
          return;
        }
        this.metrics.subscriptionsAllowed += 1;
        callback?.({ ok: true });
      })().catch(() => {
        this.metrics.subscriptionsDenied += 1;
        logSecurityEvent("realtime_acl_denied", { reason: "authorization_error", scope: "unknown" });
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

    socket.on("realtime:resume", (payload: unknown, callback?: (result: ResumeAck) => void) => {
      const cursor = parseResumeCursor(payload);
      if (cursor === null) {
        callback?.({ ok: false, error: "invalid_cursor" });
        return;
      }
      void this.replaySocket(socket, cursor)
        .then((result) => callback?.({ ok: true, ...result }))
        .catch(() => callback?.({ ok: false, error: "replay_failed" }));
    });

    socket.on("disconnect", () => {
      const timer = this.expiryTimers.get(socket.id);
      if (timer) clearTimeout(timer);
      this.expiryTimers.delete(socket.id);
      if (!countedOnline) return;
      const current = this.onlineUserCounts.get(user.id) ?? 0;
      if (current <= 1) {
        this.onlineUserCounts.delete(user.id);
        void this.publishPresenceDelta(user.id, false);
      } else {
        this.onlineUserCounts.set(user.id, current - 1);
      }
    });

    void (async () => {
      this.scheduleExpiryDisconnect(socket);
      await Promise.all([
        this.joinAuthorized(socket, { scope: "user", userId: user.id }),
        this.joinAuthorized(socket, { scope: "capability", capability: REALTIME_CAPABILITIES.CHAT_PRESENCE }),
        this.joinAuthorized(socket, { scope: "capability", capability: REALTIME_CAPABILITIES.AUDIT_READ }),
      ]);
      if (!socket.connected) return;
      const previous = this.onlineUserCounts.get(user.id) ?? 0;
      this.onlineUserCounts.set(user.id, previous + 1);
      countedOnline = true;
      socket.emit(CHAT_PRESENCE_SNAPSHOT_EVENT, {
        online_user_ids: this.listOnlineUserIds(),
        at: nowIso(),
      });
      if (previous === 0) await this.publishPresenceDelta(user.id, true);
    })().catch(() => {
      logSecurityEvent("realtime_acl_denied", { reason: "connection_setup_failed", scope: "connection" });
      socket.disconnect(true);
    });
  }

  private async authorizeSubscription(
    socket: Socket,
    subscription: RealtimeSubscription,
    accountOverride?: RealtimeAccountAuthorization | null
  ): Promise<boolean> {
    const user = currentJwtUser(socket);
    if (!user || tokenIsExpired(user)) return false;
    const account = accountOverride === undefined
      ? await this.dependencies.loadAccountAuthorization(user.id)
      : accountOverride;
    if (!account?.active || !tokenMatchesAccount(user, account)) return false;
    applyCurrentAuthorization(user, account);
    if (subscription.scope === "user") return subscription.userId === user.id;
    if (subscription.scope === "capability") {
      if (subscription.capability === REALTIME_CAPABILITIES.CHAT_PRESENCE) return true;
      if (subscription.capability === REALTIME_CAPABILITIES.AUDIT_READ) {
        const profile = await this.dependencies.resolveAccountAccessProfile(user.id);
        return profile?.is_superadmin === true;
      }
      return false;
    }
    if (subscription.scope === "station") {
      return this.dependencies.authorizeStationSubscription(subscription, user);
    }
    const moduleKey = subscription.scope === "module"
      ? subscription.moduleKey
      : moduleForRealtimeEntity(subscription.entityType);
    if (!moduleKey) return false;
    const profile = await this.dependencies.resolveAccountAccessProfile(user.id);
    return Boolean(profile && (
      profile.is_superadmin
      || profile.modules.some((entry) => entry.module_key === moduleKey && entry.allowed)
    ));
  }

  private async joinAuthorized(socket: Socket, subscription: RealtimeSubscription): Promise<boolean> {
    if (!(await this.authorizeSubscription(socket, subscription))) return false;
    await socket.join(realtimeRoomName(subscription));
    return true;
  }

  private scheduleExpiryDisconnect(socket: Socket): void {
    const user = currentJwtUser(socket);
    if (!user || typeof user.exp !== "number") return;
    const delay = Math.max(0, user.exp * 1000 - Date.now());
    const timer = setTimeout(() => {
      this.expiryTimers.delete(socket.id);
      this.metrics.expiredSessionsDisconnected += 1;
      socket.disconnect(true);
    }, Math.min(delay, 2_147_483_647));
    this.expiryTimers.set(socket.id, timer);
  }

  private listOnlineUserIds(): number[] {
    return [...this.onlineUserCounts.entries()]
      .filter(([, count]) => count > 0)
      .map(([id]) => id)
      .sort((left, right) => left - right);
  }

  private async publishPresenceDelta(userId: number, online: boolean): Promise<void> {
    try {
      await this.publish(
        CHAT_USER_PRESENCE_EVENT,
        { user_id: userId, online, at: nowIso() },
        [{ scope: "capability", capability: REALTIME_CAPABILITIES.CHAT_PRESENCE }],
        { streamId: `presence:user:${userId}` }
      );
    } catch {
      // publish() already emits privacy-safe metrics/logs; disconnect must finish.
    }
  }

  private onControlSignal(signal: RealtimeControlSignal): void {
    if (signal.kind === "session_revoked") {
      void this.disconnectUser(signal.userId);
      return;
    }
    void this.requestDrain();
  }

  private requestDrain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.drainPromise) {
      this.drainAgain = true;
      return this.drainPromise;
    }
    this.drainPromise = (async () => {
      do {
        this.drainAgain = false;
        await this.drain();
      } while (this.drainAgain && !this.stopped);
    })().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped) {
        const records = await this.controlPlane.readAfter(this.cursor, EVENT_READ_BATCH);
        if (records.length === 0) return;
        const dispatches: Promise<void>[] = [];
        for (const record of records) {
          if (record.sequence <= this.cursor) {
            this.metrics.duplicateEventsSkipped += 1;
            continue;
          }
          this.cursor = record.sequence;
          dispatches.push(this.enqueueStream(record.streamId, () => this.dispatchRecord(record)));
        }
        await Promise.all(dispatches);
        if (records.length < EVENT_READ_BATCH) return;
      }
    } catch (error) {
      this.metrics.controlPlanePollFailures += 1;
      logSecurityEvent("realtime_control_poll_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  private enqueueStream(streamId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.streamQueues.get(streamId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(operation)
      .catch((error: unknown) => {
        this.metrics.recipientDispatchErrors += 1;
        logSecurityEvent("realtime_stream_dispatch_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      });
    this.streamQueues.set(streamId, current);
    void current.then(() => {
      if (this.streamQueues.get(streamId) === current) this.streamQueues.delete(streamId);
    });
    return current;
  }

  private async dispatchRecord(record: RealtimeEventRecord, onlySocket?: Socket): Promise<void> {
    const targets = record.targets.map(canonicalStoredTarget);
    if (targets.length === 0 || targets.some((target) => !target)) {
      this.metrics.invalidEmissionTargets += 1;
      return;
    }
    const sockets = onlySocket ? [onlySocket] : [...this.io.sockets.sockets.values()];
    const accountLoads = new Map<number, Promise<RealtimeAccountAuthorization | null>>();
    let matchingRecipients = 0;
    const results = await Promise.allSettled(sockets.map(async (socket) => {
      const matching = (targets as RealtimeSubscription[]).filter((target) => socket.rooms.has(realtimeRoomName(target)));
      if (matching.length === 0) return;
      matchingRecipients += 1;
      const deliveredIds = socket.data.deliveredRealtimeEventIds as Map<string, true> | undefined;
      if (deliveredIds?.has(record.eventId)) {
        this.metrics.duplicateEventsSkipped += 1;
        return;
      }
      const user = currentJwtUser(socket);
      if (!user) return;
      let accountLoad = accountLoads.get(user.id);
      if (!accountLoad) {
        accountLoad = this.dependencies.loadAccountAuthorization(user.id);
        accountLoads.set(user.id, accountLoad);
      }
      const account = await accountLoad;
      if (!account?.active || !tokenMatchesAccount(user, account)) {
        this.metrics.emissionRecipientsDenied += 1;
        socket.disconnect(true);
        return;
      }
      let allowed = false;
      for (const target of matching) {
        try {
          if (await this.authorizeSubscription(socket, target, account)) {
            allowed = true;
          } else {
            this.metrics.emissionRecipientsDenied += 1;
            await socket.leave(realtimeRoomName(target));
          }
        } catch {
          this.metrics.recipientDispatchErrors += 1;
          logSecurityEvent("realtime_recipient_authorization_failed", { scope: target.scope });
        }
      }
      if (!allowed) return;
      socket.emit(record.event, decoratedPayload(record));
      if (deliveredIds) {
        deliveredIds.set(record.eventId, true);
        while (deliveredIds.size > MAX_DELIVERED_EVENT_IDS) {
          const oldest = deliveredIds.keys().next().value as string | undefined;
          if (!oldest) break;
          deliveredIds.delete(oldest);
        }
      }
      this.metrics.emissionsDelivered += 1;
      if (onlySocket) this.metrics.replayEventsDelivered += 1;
    }));
    const rejected = results.filter((result) => result.status === "rejected").length;
    if (rejected > 0) {
      this.metrics.recipientDispatchErrors += rejected;
      logSecurityEvent("realtime_recipient_dispatch_failed", { count: rejected, event: record.event });
    }
    if (matchingRecipients === 0) {
      this.metrics.deliveryBatchesWithoutRecipients += 1;
      logSecurityEvent("realtime_delivery_without_local_recipient", { event: record.event });
    }
  }

  private async replaySocket(socket: Socket, afterSequence: bigint): Promise<{ lastSequence: string; truncated: boolean }> {
    const user = currentJwtUser(socket);
    if (!user) throw new Error("UNAUTHORIZED");
    const account = await this.dependencies.loadAccountAuthorization(user.id);
    if (!account?.active || !tokenMatchesAccount(user, account)) {
      socket.disconnect(true);
      throw new Error("UNAUTHORIZED");
    }
    let cursor = afterSequence;
    let delivered = 0;
    while (delivered < MAX_REPLAY_EVENTS) {
      const records = await this.controlPlane.readAfter(cursor, Math.min(EVENT_READ_BATCH, MAX_REPLAY_EVENTS - delivered));
      if (records.length === 0) break;
      for (const record of records) {
        cursor = record.sequence;
        await this.enqueueStream(record.streamId, () => this.dispatchRecord(record, socket));
        delivered += 1;
      }
      if (records.length < EVENT_READ_BATCH) break;
    }
    const remaining = await this.controlPlane.readAfter(cursor, 1);
    return { lastSequence: cursor.toString(), truncated: remaining.length > 0 };
  }

  private async disconnectUser(userId: number): Promise<void> {
    for (const socket of this.io.sockets.sockets.values()) {
      if (currentJwtUser(socket)?.id !== userId) continue;
      this.metrics.revokedSessionsDisconnected += 1;
      socket.disconnect(true);
    }
  }

  private async revalidateConnectedSessions(): Promise<void> {
    const loads = new Map<number, Promise<RealtimeAccountAuthorization | null>>();
    await Promise.allSettled([...this.io.sockets.sockets.values()].map(async (socket) => {
      const user = currentJwtUser(socket);
      if (!user) return;
      let load = loads.get(user.id);
      if (!load) {
        load = this.dependencies.loadAccountAuthorization(user.id);
        loads.set(user.id, load);
      }
      const account = await load;
      if (!account?.active || !tokenMatchesAccount(user, account)) {
        this.metrics.revokedSessionsDisconnected += 1;
        socket.disconnect(true);
      }
    }));
  }
}

let defaultRuntime: RealtimeSocketRuntime | null = null;

export function createRealtimeSocketRuntime(
  server: HttpServer,
  overrides: Partial<SocketAuthorizationDependencies> = {},
  options: RealtimeRuntimeOptions = {}
): RealtimeSocketRuntime {
  return new RealtimeSocketRuntime(server, overrides, options);
}

export const initSocketServer = (
  server: HttpServer,
  overrides: Partial<SocketAuthorizationDependencies> = {},
  options: RealtimeRuntimeOptions = {}
): SocketIOServer => {
  defaultRuntime = createRealtimeSocketRuntime(server, overrides, options);
  void defaultRuntime.start().catch((error: unknown) => {
    logSecurityEvent("realtime_control_start_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  });
  return defaultRuntime.io;
};

export async function publishRealtimeEvent(
  event: string,
  payload: unknown,
  targets: readonly RealtimeSubscription[],
  options: PublishRealtimeOptions = {}
): Promise<RealtimeEventRecord> {
  if (!defaultRuntime) {
    if (process.env.NODE_ENV === "test") {
      return {
        sequence: 0n,
        eventId: "00000000-0000-0000-0000-000000000000",
        streamId: options.streamId ?? deriveStreamId(event, targets),
        event,
        payload,
        targets: [...targets],
        occurredAt: nowIso(),
      };
    }
    throw new Error("REALTIME_NOT_INITIALIZED");
  }
  return defaultRuntime.publish(event, payload, targets, options);
}

/** Compatibility export: all emissions now mean a durable control-plane publish. */
export async function emitToAuthorizedSubscribers(
  event: string,
  payload: unknown,
  targets: readonly RealtimeSubscription[]
): Promise<void> {
  await publishRealtimeEvent(event, payload, targets);
}

export async function revokeUserRealtimeSessions(
  userId: number,
  options: { durable?: boolean } = {}
): Promise<void> {
  if (!defaultRuntime) return;
  await defaultRuntime.revokeUser(userId, options.durable ?? true);
}

export function getRealtimeSecurityMetrics(): Readonly<RealtimeSecurityMetrics> {
  return defaultRuntime?.getMetrics() ?? createMetrics();
}

export function getIO(): SocketIOServer {
  if (!defaultRuntime) throw new Error("Socket.io n'est pas initialisé !");
  return defaultRuntime.io;
}
