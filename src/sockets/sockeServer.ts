import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { Server as SocketIOServer, type Socket } from "socket.io";

import {
  invalidateAccessCache,
  resolveAccessProfile,
} from "../module/access-control/services/access-control.service";
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
  RealtimeCursorTooOldError,
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
  MemoryChatPresenceRegistry,
  PostgresChatPresenceRegistry,
  type ChatPresenceDelta,
  type ChatPresenceRegistry,
} from "../shared/realtime/chat-presence.registry";
import {
  REALTIME_CAPABILITIES,
  moduleForRealtimeEntity,
  normalizeClientRealtimeSubscription,
  normalizeRealtimeSubscription,
  parseRealtimeRoomName,
  realtimeAccessProfileAllowsModule,
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

type RoomAck = {
  ok: boolean;
  error?: "invalid_subscription" | "forbidden" | "too_many_rooms" | "authorization_unavailable" | "superseded";
};
type ResumeAck = {
  ok: boolean;
  error?: "invalid_cursor" | "forbidden" | "replay_failed" | "cursor_too_old" | "cursor_in_future";
  lastSequence?: string;
  earliestSequence?: string | null;
  fullResyncRequired?: boolean;
  truncated?: boolean;
  presenceSnapshot?: {
    availability: "known" | "unknown";
    online_user_ids: number[];
    at: string;
  };
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
  presenceHeartbeatFailures: number;
  presenceLeaseRecoveries: number;
  presenceRecipientDenied: number;
  presenceConvergenceFailures: number;
  privilegedBackstopFailures: number;
  privilegedBackstopRecoveries: number;
  privilegedBackstopSocketsDisconnected: number;
};

export type RealtimeRuntimeOptions = {
  controlPlane?: RealtimeControlPlane;
  pollIntervalMs?: number;
  sessionRevalidationMs?: number;
  pruneIntervalMs?: number;
  startupMaxAttempts?: number;
  startupRetryDelayMs?: number;
  presenceRegistry?: ChatPresenceRegistry;
  presenceHeartbeatMs?: number;
  presenceSweepMs?: number;
  privilegedBackstopRevalidationMs?: number;
};

export type RealtimeReadiness = {
  ready: boolean;
  controlPlaneReady: boolean;
  privilegedBackstopsInstalled: boolean;
};

export type PublishRealtimeOptions = {
  streamId?: string;
  deduplicationKey?: string;
};

const CHAT_PRESENCE_SNAPSHOT_EVENT = "chat:presence:snapshot";
const CHAT_USER_PRESENCE_EVENT = "chat:user:presence";
const SESSION_REVOKED_EVENT = "realtime:session-revoked";
const SERVICE_UNAVAILABLE_EVENT = "realtime:service-unavailable";
const FULL_RESYNC_REQUIRED_EVENT = "realtime:full-resync-required";
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
    presenceHeartbeatFailures: 0,
    presenceLeaseRecoveries: 0,
    presenceRecipientDenied: 0,
    presenceConvergenceFailures: 0,
    privilegedBackstopFailures: 0,
    privilegedBackstopRecoveries: 0,
    privilegedBackstopSocketsDisconnected: 0,
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

type ResumeRequest = { kind: "cursor"; afterSequence: bigint } | { kind: "bootstrap" };

function parseResumeRequest(value: unknown): ResumeRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1) return null;
  if (keys[0] === "bootstrap" && (value as { bootstrap?: unknown }).bootstrap === true) {
    return { kind: "bootstrap" };
  }
  if (keys[0] !== "afterSequence") return null;
  const cursor = (value as { afterSequence?: unknown }).afterSequence;
  if (typeof cursor !== "string" || !/^\d{1,20}$/.test(cursor)) return null;
  try {
    const parsed = BigInt(cursor);
    return parsed >= 0n ? { kind: "cursor", afterSequence: parsed } : null;
  } catch {
    return null;
  }
}

function canonicalStoredTarget(target: RealtimeSubscription): RealtimeSubscription | null {
  return normalizeRealtimeSubscription(target);
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
  private readonly presenceRegistry: ChatPresenceRegistry;
  private readonly metrics = createMetrics();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly streamQueues = new Map<string, Promise<void>>();
  private readonly pollIntervalMs: number;
  private readonly sessionRevalidationMs: number;
  private readonly pruneIntervalMs: number;
  private readonly startupMaxAttempts: number;
  private readonly startupRetryDelayMs: number;
  private readonly presenceHeartbeatMs: number;
  private readonly presenceSweepMs: number;
  private readonly privilegedBackstopRevalidationMs: number;
  private readonly presenceTimers = new Map<string, NodeJS.Timeout>();
  private cursor = 0n;
  private drainPromise: Promise<void> | null = null;
  private drainAgain = false;
  private fullResyncPromise: Promise<void> | null = null;
  private privilegedBackstopRevalidationPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private stopListener: (() => Promise<void>) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private revalidationTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private presenceSweepTimer: NodeJS.Timeout | null = null;
  private privilegedBackstopRevalidationTimer: NodeJS.Timeout | null = null;
  private startupRetryTimer: NodeJS.Timeout | null = null;
  private ready = false;
  private controlPlaneHealthy = false;
  private privilegedBackstopsInstalled = true;
  private privilegedBackstopRecoveryRequired = false;
  private authorizationHealthGeneration = 0;
  private fullResyncHealthy = true;
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
    this.presenceRegistry = options.presenceRegistry
      ?? (process.env.NODE_ENV === "test" ? new MemoryChatPresenceRegistry() : new PostgresChatPresenceRegistry());
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.sessionRevalidationMs = options.sessionRevalidationMs ?? 2_000;
    this.pruneIntervalMs = options.pruneIntervalMs ?? 60_000;
    this.startupMaxAttempts = Math.max(1, Math.trunc(options.startupMaxAttempts ?? 5));
    this.startupRetryDelayMs = Math.max(1, Math.trunc(options.startupRetryDelayMs ?? 250));
    this.presenceHeartbeatMs = Math.max(1_000, Math.trunc(options.presenceHeartbeatMs ?? 15_000));
    this.presenceSweepMs = Math.max(1_000, Math.trunc(options.presenceSweepMs ?? 15_000));
    this.privilegedBackstopRevalidationMs = Math.max(
      1,
      Math.trunc(options.privilegedBackstopRevalidationMs ?? 30_000)
    );
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
    if (this.stopped) return Promise.reject(new Error("REALTIME_RUNTIME_STOPPED"));
    if (this.ready) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    const startup = this.startWithRetry();
    this.startPromise = startup;
    void startup.then(() => {
      this.ready = true;
    }).catch(() => {
      if (this.stopped || this.startupRetryTimer) return;
      this.startupRetryTimer = setTimeout(() => {
        this.startupRetryTimer = null;
        void this.start().catch(() => undefined);
      }, this.startupRetryDelayMs);
      this.startupRetryTimer.unref();
    }).finally(() => {
      if (this.startPromise === startup) this.startPromise = null;
    });
    return startup;
  }

  private async startWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.startupMaxAttempts; attempt += 1) {
      try {
        if (this.stopped) throw new Error("REALTIME_RUNTIME_STOPPED");
        const integrity = await this.controlPlane.integrityStatus?.();
        if (integrity && !integrity.valid) {
          throw new Error("REALTIME_CONTROL_PLANE_INTEGRITY_FAILED");
        }
        this.cursor = await this.controlPlane.validatedLatestSequence();
        await this.controlPlane.flushOutbox?.(EVENT_READ_BATCH);
        // Readability is part of the initial readiness proof. A successful
        // sequence lookup alone does not prove that the durable replay path is
        // usable by this process.
        await this.controlPlane.readAfter(this.cursor, 1);
        if (!(await this.checkPrivilegedBackstops())) {
          throw new Error("REALTIME_PRIVILEGED_BACKSTOPS_MISSING");
        }
        await this.installControlPlaneListener();
        this.installTimers();
        this.setControlPlaneHealthy(true);
        void this.requestDrain();
        return;
      } catch (error) {
        this.setControlPlaneHealthy(false);
        lastError = error;
        this.metrics.controlPlanePollFailures += 1;
        if (attempt < this.startupMaxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, this.startupRetryDelayMs * attempt));
        }
      }
    }
    throw lastError;
  }

  private async installControlPlaneListener(): Promise<void> {
    if (this.stopListener) return;
    try {
      this.stopListener = await this.controlPlane.subscribe((signal) => this.onControlSignal(signal));
    } catch (error) {
      // Polling is the durable fallback; LISTEN is only a latency optimization.
      this.metrics.controlPlanePollFailures += 1;
      logSecurityEvent("realtime_control_listener_start_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  private installTimers(): void {
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.requestDrain(), this.pollIntervalMs);
      this.pollTimer.unref();
    }
    if (!this.revalidationTimer) {
      this.revalidationTimer = setInterval(() => void this.revalidateConnectedSessions(), this.sessionRevalidationMs);
      this.revalidationTimer.unref();
    }
    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => {
        void this.controlPlane.pruneExpired().catch((error: unknown) => {
          this.metrics.controlPlanePollFailures += 1;
          logSecurityEvent("realtime_retention_prune_failed", {
            error: error instanceof Error ? error.name : "unknown",
          });
        });
      }, this.pruneIntervalMs);
      this.pruneTimer.unref();
    }
    if (!this.presenceSweepTimer) {
      this.presenceSweepTimer = setInterval(() => {
        void this.presenceRegistry.sweepExpired().then(async (deltas) => {
          if (!(this.presenceRegistry instanceof PostgresChatPresenceRegistry)) {
            await Promise.all(deltas.map((delta) => this.emitPresenceDelta(delta)));
          }
          // Authoritative snapshots provide bounded convergence even if a
          // LISTEN notification was lost during a database/network failover.
          await this.convergePresenceSnapshots();
        }).catch((error: unknown) => {
          this.metrics.presenceConvergenceFailures += 1;
          logSecurityEvent("realtime_presence_convergence_failed", {
            error: error instanceof Error ? error.name : "unknown",
          });
        });
      }, this.presenceSweepMs);
      this.presenceSweepTimer.unref();
    }
    if (!this.privilegedBackstopRevalidationTimer) {
      this.privilegedBackstopRevalidationTimer = setInterval(
        () => void this.requestPrivilegedBackstopRevalidation(),
        this.privilegedBackstopRevalidationMs
      );
      this.privilegedBackstopRevalidationTimer.unref();
    }
  }

  private async checkPrivilegedBackstops(): Promise<boolean> {
    const wasInstalled = this.privilegedBackstopsInstalled;
    try {
      const status = await this.controlPlane.privilegedBackstopStatus?.();
      const installed = status?.installed === true;
      if (!installed) {
        this.metrics.privilegedBackstopFailures += 1;
        this.suspendAuthorizationForBackstopOutage();
        if (wasInstalled) {
          logSecurityEvent("realtime_privileged_backstops_missing", {
            expectedCount: status?.expectedCount ?? 11,
            installedCount: status?.installedCount ?? 0,
          });
        }
        return false;
      }
      if (!wasInstalled) {
        // A trigger outage creates an unknowable authorization window for
        // direct SQL writers. Globally revoke pre-outage credentials while
        // readiness is still false; only a fresh login may reconnect.
        if (this.privilegedBackstopRecoveryRequired) {
          await this.controlPlane.reconcileAuthorizationAfterBackstopOutage();
        }
        invalidateAccessCache();
        this.authorizationHealthGeneration += 1;
        this.privilegedBackstopRecoveryRequired = false;
        this.privilegedBackstopsInstalled = true;
        this.metrics.privilegedBackstopRecoveries += 1;
        logSecurityEvent("realtime_privileged_backstops_recovered", {
          installedCount: status?.installedCount ?? 11,
        });
        void this.requestDrain();
      } else {
        this.privilegedBackstopsInstalled = true;
      }
      return true;
    } catch (error) {
      this.metrics.privilegedBackstopFailures += 1;
      this.suspendAuthorizationForBackstopOutage();
      logSecurityEvent("realtime_privileged_backstop_check_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }

  private suspendAuthorizationForBackstopOutage(): void {
    const transitioned = this.privilegedBackstopsInstalled;
    // This assignment is deliberately the first operation. Every dispatch,
    // join, handshake and replay fence observes the suspension before any
    // socket cleanup or logging can yield.
    this.privilegedBackstopsInstalled = false;
    this.privilegedBackstopRecoveryRequired = true;
    if (!transitioned) return;
    this.authorizationHealthGeneration += 1;
    invalidateAccessCache();
    const connected = [...this.io.sockets.sockets.values()];
    this.metrics.privilegedBackstopSocketsDisconnected += connected.length;
    for (const socket of connected) {
      try {
        socket.emit(SERVICE_UNAVAILABLE_EVENT, { retryable: true });
      } finally {
        socket.disconnect(true);
      }
    }
  }

  private captureAuthorizationHealth(): number {
    if (!this.isReady()) throw new Error("REALTIME_AUTHORIZATION_UNAVAILABLE");
    return this.authorizationHealthGeneration;
  }

  private assertAuthorizationHealth(generation: number): void {
    if (!this.isReady() || generation !== this.authorizationHealthGeneration) {
      throw new Error("REALTIME_AUTHORIZATION_HEALTH_CHANGED");
    }
  }

  private requestPrivilegedBackstopRevalidation(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.privilegedBackstopRevalidationPromise) return this.privilegedBackstopRevalidationPromise;
    const revalidation = this.checkPrivilegedBackstops()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (this.privilegedBackstopRevalidationPromise === revalidation) {
          this.privilegedBackstopRevalidationPromise = null;
        }
      });
    this.privilegedBackstopRevalidationPromise = revalidation;
    return revalidation;
  }

  private setControlPlaneHealthy(healthy: boolean): void {
    if (this.controlPlaneHealthy === healthy) return;
    this.controlPlaneHealthy = healthy;
    logSecurityEvent(healthy ? "realtime_control_plane_recovered" : "realtime_control_plane_unavailable", {});
  }

  isReady(): boolean {
    return this.ready
      && this.controlPlaneHealthy
      && this.privilegedBackstopsInstalled
      && this.fullResyncHealthy;
  }

  getReadiness(): RealtimeReadiness {
    return {
      ready: this.isReady(),
      controlPlaneReady: this.ready && this.controlPlaneHealthy && this.fullResyncHealthy,
      privilegedBackstopsInstalled: this.privilegedBackstopsInstalled,
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.revalidationTimer) clearInterval(this.revalidationTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.presenceSweepTimer) clearInterval(this.presenceSweepTimer);
    if (this.privilegedBackstopRevalidationTimer) clearInterval(this.privilegedBackstopRevalidationTimer);
    if (this.startupRetryTimer) clearTimeout(this.startupRetryTimer);
    this.pollTimer = null;
    this.revalidationTimer = null;
    this.pruneTimer = null;
    this.presenceSweepTimer = null;
    this.privilegedBackstopRevalidationTimer = null;
    this.startupRetryTimer = null;
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    for (const timer of this.presenceTimers.values()) clearInterval(timer);
    this.presenceTimers.clear();
    await this.stopListener?.();
    this.stopListener = null;
    await Promise.allSettled([
      ...(this.drainPromise ? [this.drainPromise] : []),
      ...(this.fullResyncPromise ? [this.fullResyncPromise] : []),
      ...(this.privilegedBackstopRevalidationPromise ? [this.privilegedBackstopRevalidationPromise] : []),
      ...this.streamQueues.values(),
    ]);
    const connected = [...this.io.sockets.sockets.values()];
    await Promise.allSettled(connected.map(async (socket) => {
      const user = currentJwtUser(socket);
      if (user) await this.presenceRegistry.disconnect(user.id, socket.id);
      socket.disconnect(true);
    }));
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
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
    if (durable) {
      await this.start();
      await this.controlPlane.revokeSessions(userId);
    }
    await this.disconnectUser(userId);
  }

  private installSocketHandlers(): void {
    this.io.use((socket, next) => {
      void (async () => {
        try {
          await this.start();
          const healthGeneration = this.captureAuthorizationHealth();
          socket.data.authorizationHealthGeneration = healthGeneration;
        } catch {
          throw new Error("SERVICE_UNAVAILABLE");
        }
        const token = extractHandshakeToken(socket);
        if (!token) throw new Error("UNAUTHORIZED");
        if (!process.env.JWT_SECRET) throw new Error("SERVER_MISCONFIGURED");
        let decoded: JwtUser;
        try {
          decoded = jwt.verify(token, process.env.JWT_SECRET) as JwtUser;
        } catch {
          throw new Error("UNAUTHORIZED");
        }
        if (!validUserId(decoded.id) || typeof decoded.exp !== "number" || tokenIsExpired(decoded)) {
          throw new Error("UNAUTHORIZED");
        }
        let account: RealtimeAccountAuthorization | null;
        try {
          account = await this.dependencies.loadAccountAuthorization(decoded.id);
        } catch {
          throw new Error("SERVICE_UNAVAILABLE");
        }
        this.assertAuthorizationHealth(socket.data.authorizationHealthGeneration as number);
        if (!account?.active || !tokenMatchesAccount(decoded, account)) throw new Error("UNAUTHORIZED");
        applyCurrentAuthorization(decoded, account);
        socket.data.user = decoded;
        socket.data.deliveredRealtimeEventIds = new Map<string, true>();
        this.assertAuthorizationHealth(socket.data.authorizationHealthGeneration as number);
        next();
      })().catch((error: unknown) => {
        this.metrics.connectionsDenied += 1;
        const message = error instanceof Error ? error.message : "";
        const code = message === "SERVER_MISCONFIGURED" || message === "UNAUTHORIZED"
          ? message
          : "SERVICE_UNAVAILABLE";
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
    this.scheduleExpiryDisconnect(socket);
    const initialRoomsReady = Promise.all([
      this.joinAuthorized(socket, { scope: "user", userId: user.id }),
      this.joinAuthorized(socket, { scope: "capability", capability: REALTIME_CAPABILITIES.CHAT_PRESENCE }),
      this.joinAuthorized(socket, { scope: "capability", capability: REALTIME_CAPABILITIES.AUDIT_READ }),
    ]).then(([userRoomJoined, presenceRoomJoined]) => {
      if (!userRoomJoined || !presenceRoomJoined) throw new Error("INITIAL_ROOM_AUTHORIZATION_FAILED");
      if (!socket.connected) return;
      return this.registerPresence(socket, user.id);
    });
    void initialRoomsReady.catch(() => {
      logSecurityEvent("realtime_acl_denied", { reason: "connection_setup_unavailable", scope: "connection" });
      socket.emit(SERVICE_UNAVAILABLE_EVENT, { retryable: true });
      socket.disconnect(true);
    });
    let replayQueue: Promise<void> = Promise.resolve();
    // Socket.IO invokes handlers concurrently. Serialize room mutations and
    // coalesce identical requests so a burst cannot overbook MAX_SOCKET_ROOMS
    // between its check and join.
    let subscriptionQueue: Promise<void> = Promise.resolve();
    const roomIntentVersions = new Map<string, number>();
    const nextRoomIntent = (key: string): number => {
      const version = (roomIntentVersions.get(key) ?? 0) + 1;
      roomIntentVersions.set(key, version);
      return version;
    };
    socket.on("room:subscribe", (payload: unknown, callback?: (result: RoomAck) => void) => {
      const subscription = normalizeClientRealtimeSubscription(payload);
      if (!subscription) {
        this.metrics.subscriptionsDenied += 1;
        logSecurityEvent("realtime_acl_denied", { reason: "invalid_subscription", scope: "unknown" });
        callback?.({ ok: false, error: "invalid_subscription" });
        return;
      }
      const key = realtimeRoomName(subscription);
      const version = nextRoomIntent(key);
      const operation = subscriptionQueue.catch(() => undefined).then(async (): Promise<RoomAck> => {
        try {
          await initialRoomsReady;
          // A socket can outlive a readiness transition. Do not let an
          // already-connected client create new authorization state while the
          // mandatory cross-writer backstops are missing or unverifiable.
          if (!this.isReady()) {
            this.metrics.subscriptionsDenied += 1;
            logSecurityEvent("realtime_acl_denied", { reason: "service_unavailable", scope: subscription.scope });
            socket.emit(SERVICE_UNAVAILABLE_EVENT, { retryable: true });
            return { ok: false, error: "authorization_unavailable" };
          }
          if (roomIntentVersions.get(key) !== version) return { ok: false, error: "superseded" };
          if (socket.rooms.has(key)) return { ok: true };
          if (socket.rooms.size >= MAX_SOCKET_ROOMS) {
            this.metrics.subscriptionsDenied += 1;
            return { ok: false, error: "too_many_rooms" };
          }
          if (!(await this.joinAuthorized(socket, subscription))) {
            this.metrics.subscriptionsDenied += 1;
            logSecurityEvent("realtime_acl_denied", { reason: "forbidden", scope: subscription.scope });
            return { ok: false, error: "forbidden" };
          }
          if (roomIntentVersions.get(key) !== version) {
            await socket.leave(key);
            return { ok: false, error: "superseded" };
          }
          this.metrics.subscriptionsAllowed += 1;
          return { ok: true };
        } catch {
          this.metrics.subscriptionsDenied += 1;
          logSecurityEvent("realtime_acl_denied", { reason: "authorization_unavailable", scope: "unknown" });
          return { ok: false, error: "authorization_unavailable" };
        }
      });
      subscriptionQueue = operation.then(() => undefined, () => undefined);
      void operation.then((result) => callback?.(result));
    });

    socket.on("room:unsubscribe", (payload: unknown, callback?: (result: RoomAck) => void) => {
      const subscription = normalizeClientRealtimeSubscription(payload);
      if (!subscription) {
        callback?.({ ok: false, error: "invalid_subscription" });
        return;
      }
      const key = realtimeRoomName(subscription);
      nextRoomIntent(key);
      const operation = subscriptionQueue.catch(() => undefined).then(async (): Promise<RoomAck> => {
        await socket.leave(key);
        return { ok: true };
      });
      subscriptionQueue = operation.then(() => undefined, () => undefined);
      void operation.then((result) => callback?.(result));
    });

    socket.on("realtime:resume", (payload: unknown, callback?: (result: ResumeAck) => void) => {
      const request = parseResumeRequest(payload);
      if (!request) {
        callback?.({ ok: false, error: "invalid_cursor" });
        return;
      }
      const replay = replayQueue
        .catch(() => undefined)
        .then(async () => {
          await initialRoomsReady;
          if (!this.isReady()) {
            socket.emit(SERVICE_UNAVAILABLE_EVENT, { retryable: true });
            throw new Error("SERVICE_UNAVAILABLE");
          }
          const healthGeneration = this.captureAuthorizationHealth();
          const result = request.kind === "bootstrap"
            ? await this.bootstrapSocket(socket, healthGeneration)
            : await this.replaySocket(socket, request.afterSequence, healthGeneration);
          this.assertAuthorizationHealth(healthGeneration);
          return { result, healthGeneration };
        });
      replayQueue = replay.then(() => undefined, () => undefined);
      void replay
        .then(async ({ result, healthGeneration }) => {
          this.assertAuthorizationHealth(healthGeneration);
          // Presence is ephemeral and is not in the durable replay log. Return
          // an authoritative snapshot in the ACK so the client can apply it
          // *after* clearing projections/refetching during a full resync.
          if (request.kind === "bootstrap" || result.fullResyncRequired) {
            const presenceSnapshot = await this.readPresenceSnapshotPayload();
            this.assertAuthorizationHealth(healthGeneration);
            callback?.({ ...result, presenceSnapshot });
            return;
          }
          this.assertAuthorizationHealth(healthGeneration);
          callback?.(result);
        })
        .catch(() => callback?.({ ok: false, error: "replay_failed" }));
    });

    socket.on("disconnect", () => {
      const timer = this.expiryTimers.get(socket.id);
      if (timer) clearTimeout(timer);
      this.expiryTimers.delete(socket.id);
      const presenceTimer = this.presenceTimers.get(socket.id);
      if (presenceTimer) clearInterval(presenceTimer);
      this.presenceTimers.delete(socket.id);
      void this.presenceRegistry.disconnect(user.id, socket.id)
        .then((delta) => {
          if (delta && !(this.presenceRegistry instanceof PostgresChatPresenceRegistry)) {
            void this.emitPresenceDelta(delta);
          }
        })
        .catch((error: unknown) => {
          this.metrics.presenceConvergenceFailures += 1;
          logSecurityEvent("realtime_presence_disconnect_failed", {
            error: error instanceof Error ? error.name : "unknown",
          });
        });
    });

  }

  private async authorizeSubscription(
    socket: Socket,
    subscription: RealtimeSubscription,
    accountOverride?: RealtimeAccountAuthorization | null,
    expectedHealthGeneration?: number
  ): Promise<boolean> {
    const healthGeneration = expectedHealthGeneration ?? this.captureAuthorizationHealth();
    this.assertAuthorizationHealth(healthGeneration);
    const user = currentJwtUser(socket);
    if (!user || tokenIsExpired(user)) return false;
    const account = accountOverride === undefined
      ? await this.dependencies.loadAccountAuthorization(user.id)
      : accountOverride;
    this.assertAuthorizationHealth(healthGeneration);
    if (!account?.active || !tokenMatchesAccount(user, account)) return false;
    applyCurrentAuthorization(user, account);
    if (subscription.scope === "user") return subscription.userId === user.id;
    if (subscription.scope === "capability") {
      if (subscription.capability === REALTIME_CAPABILITIES.CHAT_PRESENCE) return true;
      if (subscription.capability === REALTIME_CAPABILITIES.AUDIT_READ) {
        const profile = await this.dependencies.resolveAccountAccessProfile(user.id);
        this.assertAuthorizationHealth(healthGeneration);
        return profile?.is_superadmin === true;
      }
      return false;
    }
    if (subscription.scope === "station") {
      const allowed = await this.dependencies.authorizeStationSubscription(subscription, user);
      this.assertAuthorizationHealth(healthGeneration);
      return allowed;
    }
    const moduleKey = subscription.scope === "module"
      ? subscription.moduleKey
      : moduleForRealtimeEntity(subscription.entityType);
    if (!moduleKey) return false;
    const profile = await this.dependencies.resolveAccountAccessProfile(user.id);
    this.assertAuthorizationHealth(healthGeneration);
    return realtimeAccessProfileAllowsModule(profile, moduleKey);
  }

  private async joinAuthorized(socket: Socket, subscription: RealtimeSubscription): Promise<boolean> {
    const healthGeneration = this.captureAuthorizationHealth();
    if (!(await this.authorizeSubscription(socket, subscription, undefined, healthGeneration))) return false;
    this.assertAuthorizationHealth(healthGeneration);
    const room = realtimeRoomName(subscription);
    await socket.join(room);
    try {
      this.assertAuthorizationHealth(healthGeneration);
    } catch (error) {
      await socket.leave(room);
      throw error;
    }
    return true;
  }

  private scheduleExpiryDisconnect(socket: Socket): void {
    const user = currentJwtUser(socket);
    if (!user || typeof user.exp !== "number") return;
    const delay = Math.max(0, user.exp * 1000 - Date.now());
    const timer = setTimeout(() => {
      this.expiryTimers.delete(socket.id);
      this.metrics.expiredSessionsDisconnected += 1;
      this.disconnectForAuthorization(socket, "TOKEN_EXPIRED");
    }, Math.min(delay, 2_147_483_647));
    this.expiryTimers.set(socket.id, timer);
  }

  private disconnectForAuthorization(
    socket: Socket,
    code: "TOKEN_EXPIRED" | "SESSION_REVOKED" | "ACCOUNT_CHANGED"
  ): void {
    socket.emit(SESSION_REVOKED_EVENT, { code });
    socket.disconnect(true);
  }

  private onControlSignal(signal: RealtimeControlSignal): void {
    if (signal.kind === "session_revoked") {
      void this.disconnectUser(signal.userId);
      return;
    }
    if (signal.kind === "authorization_changed") {
      invalidateAccessCache();
      void this.revalidateConnectedRoomAuthorization();
      return;
    }
    if (signal.kind === "presence_changed") {
      void this.emitPresenceDelta(signal);
      return;
    }
    if (signal.kind === "full_resync_required") {
      void this.requireFullResync()
        .then(() => this.requestDrain())
        .catch((error: unknown) => {
          this.metrics.controlPlanePollFailures += 1;
          logSecurityEvent("realtime_full_resync_failed", {
            error: error instanceof Error ? error.name : "unknown",
          });
          // The durable watermark is checked again by the regular poll. Until
          // that succeeds, readiness stays degraded and no new socket enters.
        });
      return;
    }
    void this.requestDrain();
  }

  private requireFullResync(): Promise<void> {
    if (!this.fullResyncPromise) {
      this.fullResyncPromise = this.handleFullResyncRequired()
        .then(() => { this.fullResyncHealthy = true; })
        .catch((error: unknown) => {
          this.fullResyncHealthy = false;
          throw error;
        })
        .finally(() => { this.fullResyncPromise = null; });
    }
    return this.fullResyncPromise;
  }

  private async handleFullResyncRequired(): Promise<void> {
    const barrier = await this.controlPlane.validatedLatestSequence();
    const payload = { lastSequence: barrier.toString(), at: nowIso() };
    const sockets = [...this.io.sockets.sockets.values()];
    const results = await Promise.allSettled(sockets.map(async (socket) => {
      const user = currentJwtUser(socket);
      if (!user) {
        socket.disconnect(true);
        return;
      }
      const account = await this.dependencies.loadAccountAuthorization(user.id);
      if (!account?.active || !tokenMatchesAccount(user, account)) {
        this.disconnectForAuthorization(socket, "ACCOUNT_CHANGED");
        return;
      }
      socket.emit(FULL_RESYNC_REQUIRED_EVENT, payload);
    }));
    const failures = results.reduce((count, result, index) => {
      if (result.status !== "rejected") return count;
      const socket = sockets[index];
      try {
        socket?.emit(SERVICE_UNAVAILABLE_EVENT, { retryable: true });
      } catch {
        // Disconnection is the fail-closed backstop even if transport emit fails.
      }
      try {
        socket?.disconnect(true);
      } catch {
        // Socket.IO normally cannot throw here; the socket is no longer trusted.
      }
      return count + 1;
    }, 0);
    if (failures > 0) {
      this.metrics.recipientDispatchErrors += failures;
      logSecurityEvent("realtime_full_resync_recipient_failed", { count: failures });
    }
    // Advance only after every connected socket has either received the barrier
    // or has been disconnected. No stale recipient can survive the cursor jump.
    if (barrier > this.cursor) this.cursor = barrier;
  }

  private async registerPresence(socket: Socket, userId: number): Promise<void> {
    const delta = await this.presenceRegistry.connect(userId, socket.id);
    if (delta && !(this.presenceRegistry instanceof PostgresChatPresenceRegistry)) await this.emitPresenceDelta(delta);
    // Disconnect may win while the distributed registry call is in flight.
    // Remove the just-created lease before installing a heartbeat, otherwise
    // a socket that no longer exists can remain online indefinitely.
    if (!socket.connected) {
      const cleanupDelta = await this.presenceRegistry.disconnect(userId, socket.id);
      if (cleanupDelta && !(this.presenceRegistry instanceof PostgresChatPresenceRegistry)) {
        await this.emitPresenceDelta(cleanupDelta);
      }
      return;
    }
    const timer = setInterval(() => {
      void this.presenceRegistry.heartbeat(userId, socket.id).then((heartbeatDelta) => {
        if (heartbeatDelta) this.metrics.presenceLeaseRecoveries += 1;
        if (heartbeatDelta && !(this.presenceRegistry instanceof PostgresChatPresenceRegistry)) {
          return this.emitPresenceDelta(heartbeatDelta);
        }
        return undefined;
      }).catch((error: unknown) => {
        this.metrics.presenceHeartbeatFailures += 1;
        logSecurityEvent("realtime_presence_heartbeat_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      });
    }, this.presenceHeartbeatMs);
    timer.unref();
    this.presenceTimers.set(socket.id, timer);
    await this.emitPresenceSnapshot(socket);
  }

  private async emitPresenceDelta(delta: ChatPresenceDelta): Promise<void> {
    const subscription = { scope: "capability", capability: REALTIME_CAPABILITIES.CHAT_PRESENCE } as const;
    const room = realtimeRoomName(subscription);
    const results = await Promise.allSettled([...this.io.sockets.sockets.values()].map(async (socket) => {
      if (!socket.rooms.has(room)) return;
      if (!(await this.authorizeSubscription(socket, subscription))) {
        this.metrics.presenceRecipientDenied += 1;
        await socket.leave(room);
        return;
      }
      socket.emit(CHAT_USER_PRESENCE_EVENT, { user_id: delta.userId, online: delta.online, at: nowIso() });
    }));
    const failures = results.filter((result) => result.status === "rejected").length;
    if (failures > 0) {
      this.metrics.presenceRecipientDenied += failures;
      logSecurityEvent("realtime_presence_recipient_authorization_failed", { count: failures });
    }
  }

  private async emitPresenceSnapshot(socket: Socket): Promise<void> {
    const subscription = { scope: "capability", capability: REALTIME_CAPABILITIES.CHAT_PRESENCE } as const;
    if (!(await this.authorizeSubscription(socket, subscription))) {
      this.metrics.presenceRecipientDenied += 1;
      await socket.leave(realtimeRoomName(subscription));
      throw new Error("PRESENCE_RECIPIENT_FORBIDDEN");
    }
    socket.emit(CHAT_PRESENCE_SNAPSHOT_EVENT, await this.readPresenceSnapshotPayload());
  }

  private async convergePresenceSnapshots(): Promise<void> {
    const subscription = { scope: "capability", capability: REALTIME_CAPABILITIES.CHAT_PRESENCE } as const;
    const room = realtimeRoomName(subscription);
    const payload = await this.readPresenceSnapshotPayload();
    const results = await Promise.allSettled([...this.io.sockets.sockets.values()].map(async (socket) => {
      if (!socket.rooms.has(room)) return;
      if (!(await this.authorizeSubscription(socket, subscription))) {
        this.metrics.presenceRecipientDenied += 1;
        await socket.leave(room);
        return;
      }
      socket.emit(CHAT_PRESENCE_SNAPSHOT_EVENT, payload);
    }));
    const failures = results.filter((result) => result.status === "rejected").length;
    if (failures > 0) throw new Error("PRESENCE_SNAPSHOT_RECIPIENT_AUTHORIZATION_FAILED");
  }

  private async readPresenceSnapshotPayload(): Promise<NonNullable<ResumeAck["presenceSnapshot"]>> {
    const snapshot = await this.presenceRegistry.snapshot();
    return {
      availability: snapshot.known ? "known" : "unknown",
      online_user_ids: snapshot.onlineUserIds,
      at: nowIso(),
    };
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
      await this.fullResyncPromise;
      await this.controlPlane.flushOutbox?.(EVENT_READ_BATCH);
      while (!this.stopped) {
        let records: RealtimeEventRecord[];
        try {
          records = await this.controlPlane.readAfter(this.cursor, EVENT_READ_BATCH);
        } catch (error) {
          // LISTEN/NOTIFY is only a latency hint. If the poison-remediation
          // notification was lost, durable retention state still forces the
          // same barrier before any post-barrier event can be dispatched.
          if (error instanceof RealtimeCursorTooOldError) {
            await this.requireFullResync();
            continue;
          }
          throw error;
        }
        // A successful durable read is the recovery proof required before a
        // queued record can pass dispatchRecord's readiness fence.
        this.setControlPlaneHealthy(true);
        if (records.length === 0) {
          return;
        }
        for (const record of records) {
          if (record.sequence <= this.cursor) {
            this.metrics.duplicateEventsSkipped += 1;
            continue;
          }
          // Advance only after the contiguous record has reached every local
          // matching recipient. A retry is safe because delivered event ids are
          // remembered per socket.
          await this.enqueueStream(record.streamId, () => this.dispatchRecord(record));
          this.cursor = record.sequence;
        }
        if (records.length < EVENT_READ_BATCH) {
          this.setControlPlaneHealthy(true);
          return;
        }
      }
    } catch (error) {
      this.setControlPlaneHealthy(false);
      this.metrics.controlPlanePollFailures += 1;
      logSecurityEvent("realtime_control_poll_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  private enqueueStream(streamId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.streamQueues.get(streamId) ?? Promise.resolve();
    const execution = previous
      .catch(() => undefined)
      .then(operation);
    const guarded = execution.catch((error: unknown) => {
        this.metrics.recipientDispatchErrors += 1;
        logSecurityEvent("realtime_stream_dispatch_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      });
    this.streamQueues.set(streamId, guarded);
    void guarded.then(() => {
      if (this.streamQueues.get(streamId) === guarded) this.streamQueues.delete(streamId);
    });
    return execution;
  }

  private async dispatchRecord(record: RealtimeEventRecord, onlySocket?: Socket): Promise<void> {
    // Do not rely solely on the periodic result: every durable dispatch joins
    // an in-flight backstop check or starts a fresh one. A direct SQL trigger
    // removal committed before this event is therefore observed before emit.
    await this.requestPrivilegedBackstopRevalidation();
    const healthGeneration = this.captureAuthorizationHealth();
    const targets = record.targets.map(canonicalStoredTarget);
    if (targets.length === 0 || targets.some((target) => !target)) {
      this.metrics.invalidEmissionTargets += 1;
      throw new Error("INVALID_REALTIME_STORED_TARGET");
    }
    const sockets = onlySocket ? [onlySocket] : [...this.io.sockets.sockets.values()];
    const accountLoads = new Map<number, Promise<RealtimeAccountAuthorization | null>>();
    let matchingRecipients = 0;
    const results = await Promise.allSettled(sockets.map(async (socket) => {
      this.assertAuthorizationHealth(healthGeneration);
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
      this.assertAuthorizationHealth(healthGeneration);
      if (!account?.active || !tokenMatchesAccount(user, account)) {
        this.metrics.emissionRecipientsDenied += 1;
        this.disconnectForAuthorization(socket, "ACCOUNT_CHANGED");
        return;
      }
      let allowed = false;
      for (const target of matching) {
        try {
          if (await this.authorizeSubscription(socket, target, account, healthGeneration)) {
            allowed = true;
          } else {
            this.metrics.emissionRecipientsDenied += 1;
            await socket.leave(realtimeRoomName(target));
          }
        } catch (error) {
          logSecurityEvent("realtime_recipient_authorization_failed", { scope: target.scope });
          // A transient ACL lookup failure is not a denial. Propagate it for
          // both replay and live delivery so the contiguous cursor cannot
          // advance past an event whose audience was not fully evaluated.
          throw error;
        }
      }
      if (!allowed) return;
      this.assertAuthorizationHealth(healthGeneration);
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
    this.assertAuthorizationHealth(healthGeneration);
    const rejected = results.filter((result) => result.status === "rejected").length;
    if (rejected > 0) {
      this.metrics.recipientDispatchErrors += rejected;
      logSecurityEvent("realtime_recipient_dispatch_failed", { count: rejected, event: record.event });
      throw new Error(onlySocket ? "REALTIME_REPLAY_AUTHORIZATION_FAILED" : "REALTIME_LIVE_AUTHORIZATION_FAILED");
    }
    if (matchingRecipients === 0) {
      this.metrics.deliveryBatchesWithoutRecipients += 1;
      logSecurityEvent("realtime_delivery_without_local_recipient", { event: record.event });
    }
  }

  private async replaySocket(socket: Socket, afterSequence: bigint, healthGeneration: number): Promise<ResumeAck> {
    this.assertAuthorizationHealth(healthGeneration);
    const user = currentJwtUser(socket);
    if (!user) throw new Error("UNAUTHORIZED");
    const account = await this.dependencies.loadAccountAuthorization(user.id);
    this.assertAuthorizationHealth(healthGeneration);
    if (!account?.active || !tokenMatchesAccount(user, account)) {
      this.disconnectForAuthorization(socket, "ACCOUNT_CHANGED");
      throw new Error("UNAUTHORIZED");
    }
    if (this.controlPlane.replayWindow) {
      const window = await this.controlPlane.replayWindow(afterSequence, MAX_REPLAY_EVENTS);
      this.assertAuthorizationHealth(healthGeneration);
      const retention = window.retention;
      if (afterSequence > retention.latestSequence) {
        const validatedLatest = await this.controlPlane.validatedLatestSequence();
        this.assertAuthorizationHealth(healthGeneration);
        return {
          ok: false,
          error: "cursor_in_future",
          fullResyncRequired: true,
          earliestSequence: retention.earliestSequence?.toString() ?? null,
          lastSequence: validatedLatest.toString(),
        };
      }
      if (afterSequence < retention.prunedThrough) {
        const validatedLatest = await this.controlPlane.validatedLatestSequence();
        this.assertAuthorizationHealth(healthGeneration);
        return {
          ok: false,
          error: "cursor_too_old",
          fullResyncRequired: true,
          earliestSequence: retention.earliestSequence?.toString() ?? null,
          lastSequence: validatedLatest.toString(),
        };
      }
      let cursor = afterSequence;
      for (const record of window.records) {
        this.assertAuthorizationHealth(healthGeneration);
        await this.enqueueStream(record.streamId, () => this.dispatchRecord(record, socket));
        cursor = record.sequence;
      }
      const truncated = cursor < retention.latestSequence;
      return {
        ok: true,
        lastSequence: (truncated ? cursor : retention.latestSequence).toString(),
        truncated,
      };
    }
    const retention = this.controlPlane.retentionState
      ? await this.controlPlane.retentionState()
      : { latestSequence: await this.controlPlane.latestSequence(), earliestSequence: null, prunedThrough: 0n };
    this.assertAuthorizationHealth(healthGeneration);
    if (afterSequence > retention.latestSequence) {
      const validatedLatest = await this.controlPlane.validatedLatestSequence();
      this.assertAuthorizationHealth(healthGeneration);
      return {
        ok: false,
        error: "cursor_in_future",
        fullResyncRequired: true,
        earliestSequence: retention.earliestSequence?.toString() ?? null,
        lastSequence: validatedLatest.toString(),
      };
    }
    if (afterSequence < retention.prunedThrough) {
      const validatedLatest = await this.controlPlane.validatedLatestSequence();
      this.assertAuthorizationHealth(healthGeneration);
      return {
        ok: false,
        error: "cursor_too_old",
        fullResyncRequired: true,
        earliestSequence: retention.earliestSequence?.toString() ?? null,
        lastSequence: validatedLatest.toString(),
      };
    }
    const replayThrough = retention.latestSequence;
    let cursor = afterSequence;
    let delivered = 0;
    while (delivered < MAX_REPLAY_EVENTS && cursor < replayThrough) {
      const records = await this.controlPlane.readAfter(cursor, Math.min(EVENT_READ_BATCH, MAX_REPLAY_EVENTS - delivered));
      this.assertAuthorizationHealth(healthGeneration);
      if (records.length === 0) break;
      for (const record of records) {
        if (record.sequence > replayThrough) break;
        await this.enqueueStream(record.streamId, () => this.dispatchRecord(record, socket));
        cursor = record.sequence;
        delivered += 1;
      }
      if (records.length < EVENT_READ_BATCH) break;
    }
    const truncated = cursor < replayThrough;
    return {
      ok: true,
      lastSequence: (truncated ? cursor : replayThrough).toString(),
      truncated,
    };
  }

  private async revalidateConnectedRoomAuthorization(): Promise<void> {
    await Promise.allSettled([...this.io.sockets.sockets.values()].map(async (socket) => {
      for (const roomName of [...socket.rooms]) {
        const subscription = parseRealtimeRoomName(roomName);
        if (!subscription) continue;
        if (!(await this.authorizeSubscription(socket, subscription))) {
          this.metrics.emissionRecipientsDenied += 1;
          await socket.leave(roomName);
        }
      }
    }));
  }

  private async disconnectUser(userId: number): Promise<void> {
    for (const socket of this.io.sockets.sockets.values()) {
      if (currentJwtUser(socket)?.id !== userId) continue;
      this.metrics.revokedSessionsDisconnected += 1;
      this.disconnectForAuthorization(socket, "SESSION_REVOKED");
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
        this.disconnectForAuthorization(socket, "ACCOUNT_CHANGED");
      }
    }));
  }

  private async bootstrapSocket(socket: Socket, healthGeneration: number): Promise<ResumeAck> {
    this.assertAuthorizationHealth(healthGeneration);
    const user = currentJwtUser(socket);
    if (!user) throw new Error("UNAUTHORIZED");
    const account = await this.dependencies.loadAccountAuthorization(user.id);
    this.assertAuthorizationHealth(healthGeneration);
    if (!account?.active || !tokenMatchesAccount(user, account)) {
      this.disconnectForAuthorization(socket, "ACCOUNT_CHANGED");
      throw new Error("UNAUTHORIZED");
    }
    applyCurrentAuthorization(user, account);
    const latest = await this.controlPlane.validatedLatestSequence();
    this.assertAuthorizationHealth(healthGeneration);
    return { ok: true, lastSequence: latest.toString(), truncated: false };
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

export async function shutdownRealtimeSocketServer(): Promise<void> {
  const runtime = defaultRuntime;
  defaultRuntime = null;
  await runtime?.stop();
}

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

export function getRealtimeReadiness(): RealtimeReadiness {
  return defaultRuntime?.getReadiness() ?? {
    ready: false,
    controlPlaneReady: false,
    privilegedBackstopsInstalled: false,
  };
}

export function getIO(): SocketIOServer {
  if (!defaultRuntime) throw new Error("Socket.io n'est pas initialisé !");
  return defaultRuntime.io;
}
