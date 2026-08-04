import { createServer, type Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRealtimeSocketRuntime,
  type RealtimeSocketRuntime,
  type SocketAuthorizationDependencies,
} from "../sockets/sockeServer";
import type {
  PublishRealtimeEventInput,
  RealtimeControlPlane,
  RealtimeControlSignal,
  RealtimeEventRecord,
  RealtimeReplayWindow,
  RealtimeRetentionState,
} from "../shared/realtime/realtime-control-plane";
import { RealtimeCursorTooOldError } from "../shared/realtime/realtime-control-plane";
import {
  REALTIME_CAPABILITIES,
  entityRealtimeSubscription,
  moduleRealtimeSubscription,
  normalizeRealtimeSubscription,
  type RealtimeSubscription,
} from "../shared/realtime/realtime-room-policy";

const JWT_SECRET = "local-socket-acl-test-secret";

type Ack = { ok: boolean; error?: string };
type ResumeAck = {
  ok: boolean;
  error?: string;
  lastSequence?: string;
  earliestSequence?: string | null;
  fullResyncRequired?: boolean;
  truncated?: boolean;
  presenceSnapshot?: { availability: "known" | "unknown"; online_user_ids: number[]; at: string };
};
type RunningServer = { http: HttpServer; runtime: RealtimeSocketRuntime; url: string };

class SharedMemoryControlPlane implements RealtimeControlPlane {
  readonly events: RealtimeEventRecord[] = [];
  readonly epochs = new Map<number, number>();
  readonly knownUsers = new Set<number>();
  backstopReconciliations = 0;
  failPublications = 0;
  latestSequenceFailures = 0;
  duplicateWakeups = false;
  suppressEventWakeups = false;
  prunedThrough = 0n;
  privilegedBackstopsInstalled = true;
  privilegedBackstopStatusError: Error | null = null;
  controlPlaneIntegrityValid = true;
  readAfterUnavailable = false;
  flushOutboxUnavailable = false;
  private readonly listeners = new Set<(signal: RealtimeControlSignal) => void>();
  private readonly deduplication = new Map<string, RealtimeEventRecord>();
  private nextSequence = 1n;

  async latestSequence(): Promise<bigint> {
    if (this.latestSequenceFailures > 0) {
      this.latestSequenceFailures -= 1;
      throw new Error("synthetic startup outage");
    }
    return this.events.at(-1)?.sequence ?? 0n;
  }

  async validatedLatestSequence(): Promise<bigint> {
    for (const event of this.events) {
      if (event.targets.length === 0 || event.targets.some((target) => !normalizeRealtimeSubscription(target))) {
        throw new Error("INVALID_REALTIME_STORED_EVENT");
      }
    }
    return this.latestSequence();
  }

  async retentionState(): Promise<RealtimeRetentionState> {
    const retained = this.events.filter((event) => event.sequence > this.prunedThrough);
    return {
      latestSequence: this.events.at(-1)?.sequence ?? 0n,
      earliestSequence: retained[0]?.sequence ?? null,
      prunedThrough: this.prunedThrough,
    };
  }

  async privilegedBackstopStatus() {
    if (this.privilegedBackstopStatusError) throw this.privilegedBackstopStatusError;
    return {
      installed: this.privilegedBackstopsInstalled,
      expectedCount: 8,
      installedCount: this.privilegedBackstopsInstalled ? 8 : 0,
    };
  }

  async integrityStatus() {
    return {
      valid: this.controlPlaneIntegrityValid,
      stateValid: this.controlPlaneIntegrityValid,
      provenanceValid: true,
      sequenceDefaultRemoved: true,
      constraintsValid: this.controlPlaneIntegrityValid,
    };
  }

  async reconcileAuthorizationAfterBackstopOutage(): Promise<void> {
    this.backstopReconciliations += 1;
    for (const userId of this.knownUsers) {
      this.epochs.set(userId, (this.epochs.get(userId) ?? 0) + 1);
    }
    this.signal({ kind: "authorization_changed" });
  }

  async replayWindow(sequence: bigint, limit = 2_000): Promise<RealtimeReplayWindow> {
    const retention = await this.retentionState();
    return {
      retention,
      records: sequence < retention.prunedThrough
        ? []
        : this.events.filter((event) => event.sequence > sequence && event.sequence > this.prunedThrough).slice(0, limit),
    };
  }

  async publish(input: PublishRealtimeEventInput): Promise<RealtimeEventRecord> {
    if (this.failPublications > 0) {
      this.failPublications -= 1;
      throw Object.assign(new Error("synthetic publish outage"), { code: "08006" });
    }
    if (input.deduplicationKey) {
      const existing = this.deduplication.get(input.deduplicationKey);
      if (existing) {
        this.signal({ kind: "event" });
        return existing;
      }
    }
    const sequence = this.nextSequence;
    this.nextSequence += 1n;
    const suffix = sequence.toString().padStart(12, "0");
    const record: RealtimeEventRecord = {
      sequence,
      eventId: `00000000-0000-4000-8000-${suffix}`,
      streamId: input.streamId,
      event: input.event,
      payload: input.payload,
      targets: [...input.targets],
      occurredAt: `2026-08-04T10:00:${String(Number(sequence % 60n)).padStart(2, "0")}.000Z`,
    };
    this.events.push(record);
    if (input.deduplicationKey) this.deduplication.set(input.deduplicationKey, record);
    if (!this.suppressEventWakeups) this.signal({ kind: "event" });
    return record;
  }

  async readAfter(sequence: bigint, limit = 500): Promise<RealtimeEventRecord[]> {
    if (this.readAfterUnavailable) throw new Error("synthetic readAfter outage");
    if (sequence < this.prunedThrough) throw new RealtimeCursorTooOldError(this.prunedThrough);
    return this.events
      .filter((event) => event.sequence > sequence && event.sequence > this.prunedThrough)
      .slice(0, limit);
  }

  async flushOutbox(): Promise<number> {
    if (this.flushOutboxUnavailable) throw new Error("synthetic flushOutbox outage");
    return 0;
  }

  async revokeSessions(userId: number): Promise<number> {
    const epoch = (this.epochs.get(userId) ?? 0) + 1;
    this.epochs.set(userId, epoch);
    this.signal({ kind: "session_revoked", userId });
    return epoch;
  }

  async subscribe(listener: (signal: RealtimeControlSignal) => void): Promise<() => Promise<void>> {
    this.listeners.add(listener);
    return async () => {
      this.listeners.delete(listener);
    };
  }

  emitControlSignal(signal: RealtimeControlSignal): void {
    this.signal(signal);
  }

  async pruneExpired(): Promise<number> {
    return 0;
  }

  private signal(signal: RealtimeControlSignal): void {
    for (const listener of this.listeners) {
      listener(signal);
      if (this.duplicateWakeups) listener(signal);
    }
  }
}

describe("Socket.IO shared room ACL", () => {
  const clients: ClientSocket[] = [];
  const servers: RunningServer[] = [];
  const activeUsers = new Set<number>();
  const moduleAccess = new Map<number, Set<string>>();
  const superadmins = new Set<number>();
  const currentRoles = new Map<number, string>();
  const authorizationFailures = new Set<number>();
  const profileFailures = new Set<number>();
  let profileGate: Promise<void> | null = null;
  let profileCalls = 0;
  let controlPlane: SharedMemoryControlPlane;

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    activeUsers.clear();
    moduleAccess.clear();
    superadmins.clear();
    currentRoles.clear();
    authorizationFailures.clear();
    profileFailures.clear();
    profileGate = null;
    profileCalls = 0;
    controlPlane = new SharedMemoryControlPlane();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    for (const server of servers.splice(0)) {
      await server.runtime.stop();
      await new Promise<void>((resolve) => {
        if (!server.http.listening) return resolve();
        server.http.close(() => resolve());
      });
    }
    vi.restoreAllMocks();
  });

  function dependencies(): Partial<SocketAuthorizationDependencies> {
    return {
      loadAccountAuthorization: async (userId) => {
        controlPlane.knownUsers.add(userId);
        if (authorizationFailures.has(userId)) throw new Error("synthetic authorization failure");
        const role = currentRoles.get(userId) ?? "Employee";
        return activeUsers.has(userId)
          ? {
              active: true,
              role,
              primaryRole: role,
              roles: [role],
              sessionEpoch: controlPlane.epochs.get(userId) ?? 0,
            }
          : null;
      },
      resolveAccountAccessProfile: async (userId) => {
        profileCalls += 1;
        await profileGate;
        if (profileFailures.has(userId)) throw new Error("synthetic profile failure");
        return {
          is_superadmin: superadmins.has(userId),
          modules: [...(moduleAccess.get(userId) ?? new Set<string>())].map((moduleKey) => ({
            module_key: moduleKey,
            label: moduleKey,
            nav_page_keys: [],
            allowed: true,
            source: "DEFAULT" as const,
          })),
        };
      },
      authorizeStationSubscription: async (_subscription, user) => user.role === "Production",
    };
  }

  async function startServer(options: {
    pollIntervalMs?: number;
    privilegedBackstopRevalidationMs?: number;
  } = {}): Promise<RunningServer> {
    const http = createServer();
    const runtime = createRealtimeSocketRuntime(http, dependencies(), {
      controlPlane,
      pollIntervalMs: options.pollIntervalMs ?? 10_000,
      sessionRevalidationMs: 10_000,
      pruneIntervalMs: 10_000,
      privilegedBackstopRevalidationMs: options.privilegedBackstopRevalidationMs ?? 10_000,
    });
    await runtime.start();
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Test server address unavailable");
    const server = { http, runtime, url: `http://127.0.0.1:${address.port}` };
    servers.push(server);
    return server;
  }

  function token(userId: number, options: {
    expiresIn?: number | string;
    epoch?: number;
    legacy?: boolean;
  } = {}): string {
    const payload: Record<string, unknown> = {
      id: userId,
      role: "Employee",
      primary_role: "Employee",
      roles: ["Employee"],
    };
    if (!options.legacy) {
      payload.session_epoch = options.epoch ?? controlPlane.epochs.get(userId) ?? 0;
      payload.jti = `00000000-0000-4000-8000-${String(userId).padStart(12, "0")}`;
    }
    return jwt.sign(payload, JWT_SECRET, {
      expiresIn: (options.expiresIn ?? "5m") as jwt.SignOptions["expiresIn"],
    });
  }

  async function connect(
    server: RunningServer,
    userId: number,
    options: { token?: string; expiresIn?: number | string } = {}
  ): Promise<ClientSocket> {
    activeUsers.add(userId);
    const client = connectClient(server.url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth: { token: options.token ?? token(userId, { expiresIn: options.expiresIn }) },
    });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });
    return client;
  }

  async function expectRejected(server: RunningServer, userId: number, signedToken: string): Promise<void> {
    activeUsers.add(userId);
    const client = connectClient(server.url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth: { token: signedToken },
    });
    clients.push(client);
    const error = await new Promise<Error>((resolve) => client.once("connect_error", resolve));
    expect(error.message).toBe("UNAUTHORIZED");
  }

  async function connectionError(server: RunningServer, userId: number): Promise<Error> {
    activeUsers.add(userId);
    const client = connectClient(server.url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth: { token: token(userId) },
    });
    clients.push(client);
    return new Promise<Error>((resolve) => client.once("connect_error", resolve));
  }

  async function subscribe(client: ClientSocket, subscription: unknown): Promise<Ack> {
    return new Promise<Ack>((resolve) => {
      client.emit("room:subscribe", subscription, (ack: Ack | undefined) => {
        resolve(ack ?? { ok: false, error: "missing_ack" });
      });
    });
  }

  async function resume(client: ClientSocket, sequence: bigint): Promise<ResumeAck> {
    return new Promise<ResumeAck>((resolve) => {
      client.emit("realtime:resume", { afterSequence: sequence.toString() }, (ack: ResumeAck | undefined) => {
        resolve(ack ?? { ok: false, error: "missing_ack" });
      });
    });
  }

  async function bootstrap(client: ClientSocket): Promise<ResumeAck> {
    return new Promise<ResumeAck>((resolve) => {
      client.emit("realtime:resume", { bootstrap: true }, (ack: ResumeAck | undefined) => {
        resolve(ack ?? { ok: false, error: "missing_ack" });
      });
    });
  }

  async function eventually(assertion: () => void, timeoutMs = 1_500): Promise<void> {
    const started = Date.now();
    while (true) {
      try {
        assertion();
        return;
      } catch (error) {
        if (Date.now() - started >= timeoutMs) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }

  it("rejects raw, unknown and cross-module subscriptions by default", async () => {
    const server = await startServer();
    moduleAccess.set(1, new Set(["production"]));
    const client = await connect(server, 1);

    await expect(subscribe(client, { room: "erp:global" })).resolves.toEqual({ ok: false, error: "invalid_subscription" });
    await expect(subscribe(client, { scope: "module", moduleKey: "production" })).resolves.toEqual({ ok: true });
    await expect(subscribe(client, { scope: "module", moduleKey: "qualite" })).resolves.toEqual({ ok: false, error: "forbidden" });
    await expect(subscribe(client, { scope: "entity", entityType: "UNKNOWN", entityId: "1" })).resolves.toEqual({ ok: false, error: "invalid_subscription" });
    await expect(subscribe(client, { scope: "user", userId: 1 })).resolves.toEqual({ ok: false, error: "invalid_subscription" });
  });

  it("serializes a concurrent room burst so it cannot overbook the socket limit", async () => {
    let releaseGate!: () => void;
    profileGate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const server = await startServer();
    moduleAccess.set(73, new Set(["production"]));
    const client = await connect(server, 73);
    const acks = Array.from({ length: 100 }, (_, index) => subscribe(client, {
      scope: "entity", entityType: "OF", entityId: `burst-${index}`,
    }));
    releaseGate();
    const results = await Promise.all(acks);
    expect(results.filter((result) => result.ok)).toHaveLength(61);
    expect(results.filter((result) => result.error === "too_many_rooms")).toHaveLength(39);
    // Three reserved rooms: Socket.IO private, user and presence capability
    // (the audit room is correctly denied for this non-superadmin account).
    expect(server.runtime.io.sockets.sockets.values().next().value?.rooms.size).toBe(64);
    // One initial audit ACL lookup plus only the 60 admitted room checks.
    expect(profileCalls).toBeLessThanOrEqual(62);
  });

  it("classifies an account lookup outage as retryable instead of unauthorized", async () => {
    const server = await startServer();
    authorizationFailures.add(71);
    await expect(connectionError(server, 71)).resolves.toMatchObject({ message: "SERVICE_UNAVAILABLE" });
  });

  it("distinguishes a transient room authorization outage from a true deny", async () => {
    const server = await startServer();
    moduleAccess.set(72, new Set(["production"]));
    const client = await connect(server, 72);
    profileFailures.add(72);
    await expect(subscribe(client, { scope: "module", moduleKey: "production" }))
      .resolves.toEqual({ ok: false, error: "authorization_unavailable" });
    profileFailures.delete(72);
    await expect(subscribe(client, { scope: "module", moduleKey: "production" }))
      .resolves.toEqual({ ok: true });
    await expect(subscribe(client, { scope: "module", moduleKey: "qualite" }))
      .resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("delivers once to the minimum authorized target union", async () => {
    const server = await startServer();
    moduleAccess.set(1, new Set(["production"]));
    moduleAccess.set(2, new Set(["qualite"]));
    const productionClient = await connect(server, 1);
    const qualityClient = await connect(server, 2);
    const productionEvents = vi.fn();
    const qualityEvents = vi.fn();
    productionClient.on("entity:changed", productionEvents);
    qualityClient.on("entity:changed", qualityEvents);
    await subscribe(productionClient, { scope: "module", moduleKey: "production" });
    await subscribe(productionClient, { scope: "entity", entityType: "OF", entityId: "42" });
    await subscribe(qualityClient, { scope: "entity", entityType: "NCR", entityId: "nc-1" });
    const module = moduleRealtimeSubscription("production");
    const entity = entityRealtimeSubscription("OF", "42");
    if (!module || !entity) throw new Error("Missing test target");

    await server.runtime.publish("entity:changed", { entityType: "OF", entityId: "42" }, [module, entity]);
    await eventually(() => expect(productionEvents).toHaveBeenCalledTimes(1));
    expect(qualityEvents).not.toHaveBeenCalled();
    expect(productionEvents.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      event_id: expect.any(String),
      sequence: expect.any(String),
      stream_id: "entity:OF:42",
    }));
  });

  it("revalidates role/module access on delivery and isolates a recipient authorization error", async () => {
    const server = await startServer();
    moduleAccess.set(3, new Set(["production"]));
    moduleAccess.set(4, new Set(["production"]));
    const failing = await connect(server, 3);
    const healthy = await connect(server, 4);
    const failingEvents = vi.fn();
    const healthyEvents = vi.fn();
    failing.on("entity:changed", failingEvents);
    healthy.on("entity:changed", healthyEvents);
    await subscribe(failing, { scope: "module", moduleKey: "production" });
    await subscribe(healthy, { scope: "module", moduleKey: "production" });
    authorizationFailures.add(3);
    const target = moduleRealtimeSubscription("production");
    if (!target) throw new Error("Missing production target");

    await server.runtime.publish("entity:changed", { entityType: "OF", entityId: "1" }, [target]);
    await eventually(() => expect(healthyEvents).toHaveBeenCalledTimes(1));
    expect(failingEvents).not.toHaveBeenCalled();
    expect(server.runtime.getMetrics().recipientDispatchErrors).toBeGreaterThan(0);
  });

  it("never advances past a failed live record and retries the contiguous prefix without duplicates", async () => {
    const server = await startServer({ pollIntervalMs: 10 });
    moduleAccess.set(31, new Set(["production"]));
    moduleAccess.set(32, new Set(["production"]));
    const transient = await connect(server, 31);
    const healthy = await connect(server, 32);
    const transientEvents: Array<{ marker?: number }> = [];
    const healthyEvents: Array<{ marker?: number }> = [];
    transient.on("entity:changed", (payload) => transientEvents.push(payload as { marker?: number }));
    healthy.on("entity:changed", (payload) => healthyEvents.push(payload as { marker?: number }));
    await subscribe(transient, { scope: "module", moduleKey: "production" });
    await subscribe(healthy, { scope: "module", moduleKey: "production" });
    const target = moduleRealtimeSubscription("production");
    if (!target) throw new Error("Missing production target");

    // Fail inside authorizeSubscription (access-profile resolution), not in
    // the earlier account load, so this covers the inner authorization catch.
    profileFailures.add(31);
    await controlPlane.publish({
      event: "entity:changed",
      payload: { marker: 1 },
      targets: [target],
      streamId: "module:production",
    });
    await controlPlane.publish({
      event: "entity:changed",
      payload: { marker: 2 },
      targets: [target],
      streamId: "module:production",
    });

    await eventually(() => expect(healthyEvents.map((event) => event.marker)).toEqual([1]));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(healthyEvents.map((event) => event.marker)).toEqual([1]);
    expect(transientEvents).toEqual([]);

    profileFailures.delete(31);
    await eventually(() => expect(transientEvents.map((event) => event.marker)).toEqual([1, 2]));
    await eventually(() => expect(healthyEvents.map((event) => event.marker)).toEqual([1, 2]));
  });

  it("keeps user and audit events in server-assigned rooms", async () => {
    const server = await startServer();
    superadmins.add(5);
    const admin = await connect(server, 5);
    const employee = await connect(server, 6);
    const adminNotification = vi.fn();
    const employeeNotification = vi.fn();
    const adminAudit = vi.fn();
    const employeeAudit = vi.fn();
    admin.on("app-notification:created", adminNotification);
    employee.on("app-notification:created", employeeNotification);
    admin.on("audit:new", adminAudit);
    employee.on("audit:new", employeeAudit);

    await eventually(() => {
      const auditMembers = [...server.runtime.io.sockets.sockets.values()]
        .filter((socket) => socket.rooms.has("rt:capability:audit:read"));
      expect(auditMembers).toHaveLength(1);
    });

    await server.runtime.publish("app-notification:created", { id: "n-1" }, [{ scope: "user", userId: 5 }]);
    await server.runtime.publish("audit:new", { auditId: "a-1" }, [
      { scope: "capability", capability: REALTIME_CAPABILITIES.AUDIT_READ },
    ], { deduplicationKey: "audit:new:a-1" });
    await server.runtime.publish("audit:new", { auditId: "a-1" }, [
      { scope: "capability", capability: REALTIME_CAPABILITIES.AUDIT_READ },
    ], { deduplicationKey: "audit:new:a-1" });

    await eventually(() => expect(adminNotification).toHaveBeenCalledTimes(1));
    await eventually(() => expect(adminAudit).toHaveBeenCalledTimes(1));
    expect(employeeNotification).not.toHaveBeenCalled();
    expect(employeeAudit).not.toHaveBeenCalled();
  });

  it("disconnects an expired JWT", async () => {
    const server = await startServer();
    const client = await connect(server, 7, { expiresIn: 2 });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("expiry disconnect timeout")), 4_000);
      client.once("disconnect", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    expect(server.runtime.getMetrics().expiredSessionsDisconnected).toBeGreaterThan(0);
  }, 10_000);

  it("propagates durable revocation across two instances and accepts only the new epoch in the same millisecond", async () => {
    const serverA = await startServer();
    const serverB = await startServer();
    moduleAccess.set(8, new Set(["production"]));
    const oldToken = token(8);
    const clientA = await connect(serverA, 8, { token: oldToken });
    const clientB = await connect(serverB, 8, { token: oldToken });
    const disconnectedA = new Promise<void>((resolve) => clientA.once("disconnect", () => resolve()));
    const disconnectedB = new Promise<void>((resolve) => clientB.once("disconnect", () => resolve()));

    await serverA.runtime.revokeUser(8, true);
    await Promise.all([disconnectedA, disconnectedB]);
    await expectRejected(serverB, 8, oldToken);
    const freshToken = token(8, { epoch: 1 });
    const fresh = await connect(serverB, 8, { token: freshToken });
    await expect(subscribe(fresh, { scope: "module", moduleKey: "production" })).resolves.toEqual({ ok: true });
    expect(controlPlane.epochs.get(8)).toBe(1);
  });

  it("supports legacy epoch-zero rollout but rejects that token after any shared bump", async () => {
    const server = await startServer();
    const legacy = token(9, { legacy: true });
    const connected = await connect(server, 9, { token: legacy });
    const disconnected = new Promise<void>((resolve) => connected.once("disconnect", () => resolve()));
    await server.runtime.revokeUser(9, true);
    await disconnected;
    await expectRejected(server, 9, legacy);
  });

  it("publishes across instances and records zero local recipients without claiming local delivery", async () => {
    const serverA = await startServer();
    const serverB = await startServer();
    moduleAccess.set(10, new Set(["production"]));
    const clientB = await connect(serverB, 10);
    const events = vi.fn();
    clientB.on("entity:changed", events);
    await subscribe(clientB, { scope: "module", moduleKey: "production" });
    const target = moduleRealtimeSubscription("production");
    if (!target) throw new Error("Missing production target");

    const stored = await serverA.runtime.publish("entity:changed", { entityType: "OF", entityId: "cross" }, [target]);
    await eventually(() => expect(events).toHaveBeenCalledTimes(1));
    await eventually(() => expect(serverA.runtime.getMetrics().deliveryBatchesWithoutRecipients).toBeGreaterThan(0));
    expect(stored.sequence).toBeGreaterThan(0n);
    expect(serverA.runtime.getMetrics().eventsPublished).toBeGreaterThan(0);
    expect(serverA.runtime.getMetrics().emissionsDelivered).toBe(0);
  });

  it("recovers a lost event wakeup through ordered polling on the other instance", async () => {
    const serverA = await startServer({ pollIntervalMs: 10 });
    const serverB = await startServer({ pollIntervalMs: 10 });
    moduleAccess.set(13, new Set(["production"]));
    const clientB = await connect(serverB, 13);
    const events = vi.fn();
    clientB.on("entity:changed", events);
    await subscribe(clientB, { scope: "module", moduleKey: "production" });
    const target = moduleRealtimeSubscription("production");
    if (!target) throw new Error("Missing production target");
    controlPlane.suppressEventWakeups = true;

    await serverA.runtime.publish("entity:changed", { entityType: "OF", entityId: "poll" }, [target]);
    await eventually(() => expect(events).toHaveBeenCalledTimes(1));
    expect(serverB.runtime.getMetrics().controlPlanePollFailures).toBe(0);
  });

  it("discovers a lost full-resync notification by polling before dispatching post-barrier events", async () => {
    const server = await startServer({ pollIntervalMs: 10 });
    moduleAccess.set(131, new Set(["production"]));
    const client = await connect(server, 131);
    const target = moduleRealtimeSubscription("production");
    if (!target) throw new Error("Missing production target");
    await subscribe(client, target);
    const observed: string[] = [];
    const resyncPayloads: Array<{ lastSequence: string }> = [];
    client.on("realtime:full-resync-required", (payload: { lastSequence: string }) => {
      resyncPayloads.push(payload);
      observed.push("resync");
    });
    client.on("entity:changed", (payload: { marker?: number }) => observed.push(`event:${payload.marker}`));
    controlPlane.suppressEventWakeups = true;

    await controlPlane.publish({
      event: "entity:changed",
      payload: { entityType: "OF", entityId: "barrier", marker: 1 },
      targets: [target],
      streamId: "module:production",
    });
    controlPlane.prunedThrough = 1n;
    await controlPlane.publish({
      event: "entity:changed",
      payload: { entityType: "OF", entityId: "after-barrier", marker: 2 },
      targets: [target],
      streamId: "module:production",
    });

    await eventually(() => expect(resyncPayloads).toEqual([expect.objectContaining({ lastSequence: "2" })]));
    expect(observed).toEqual(["resync"]);

    await controlPlane.publish({
      event: "entity:changed",
      payload: { entityType: "OF", entityId: "after-resync", marker: 3 },
      targets: [target],
      streamId: "module:production",
    });
    await eventually(() => expect(observed).toEqual(["resync", "event:3"]));
    expect(server.runtime.getMetrics().controlPlanePollFailures).toBe(0);
  });

  it("disconnects a recipient whose account cannot be reauthorized before advancing a full-resync barrier", async () => {
    const server = await startServer();
    const client = await connect(server, 132);
    const disconnected = new Promise<void>((resolve) => client.once("disconnect", () => resolve()));
    const unavailable = vi.fn();
    client.on("realtime:service-unavailable", unavailable);
    controlPlane.suppressEventWakeups = true;
    await controlPlane.publish({
      event: "entity:changed",
      payload: { entityType: "OF", entityId: "reauth-failure" },
      targets: [{ scope: "user", userId: 132 }],
      streamId: "user:132",
    });
    authorizationFailures.add(132);

    controlPlane.emitControlSignal({ kind: "full_resync_required" });
    await disconnected;
    expect(unavailable).toHaveBeenCalledWith({ retryable: true });
    expect(server.runtime.getMetrics().recipientDispatchErrors).toBe(1);
  });

  it("contains a rejected full-resync signal, degrades readiness, and converges on polling", async () => {
    const server = await startServer({ pollIntervalMs: 10 });
    const client = await connect(server, 133);
    const resync = vi.fn();
    client.on("realtime:full-resync-required", resync);
    controlPlane.suppressEventWakeups = true;
    await controlPlane.publish({
      event: "entity:changed",
      payload: { entityType: "OF", entityId: "retry-barrier" },
      targets: [{ scope: "user", userId: 133 }],
      streamId: "user:133",
    });
    controlPlane.prunedThrough = 1n;
    controlPlane.latestSequenceFailures = 1;

    controlPlane.emitControlSignal({ kind: "full_resync_required" });
    await eventually(() => expect(server.runtime.isReady()).toBe(false));
    await eventually(() => expect(resync).toHaveBeenCalledWith(expect.objectContaining({ lastSequence: "1" })));
    expect(server.runtime.isReady()).toBe(true);
    expect(server.runtime.getMetrics().controlPlanePollFailures).toBeGreaterThanOrEqual(1);
  });

  it("replays retained lock events after restart in stream order and deduplicates duplicate wakeups", async () => {
    controlPlane.duplicateWakeups = true;
    const serverA = await startServer();
    let serverB = await startServer();
    moduleAccess.set(11, new Set(["production"]));
    const target = entityRealtimeSubscription("OF", "restart-1");
    if (!target) throw new Error("Missing OF target");
    const client = await connect(serverB, 11);
    const firstEvents = vi.fn();
    client.on("lock:updated", firstEvents);
    await subscribe(client, target);
    const first = await serverA.runtime.publish("lock:updated", { entityType: "OF", entityId: "restart-1", locked: true }, [target]);
    await eventually(() => expect(firstEvents).toHaveBeenCalledTimes(1));
    client.disconnect();
    await serverB.runtime.stop();
    await new Promise<void>((resolve) => serverB.http.close(() => resolve()));
    servers.splice(servers.indexOf(serverB), 1);

    await serverA.runtime.publish("lock:updated", { entityType: "OF", entityId: "restart-1", locked: false, marker: 2 }, [target]);
    await serverA.runtime.publish("lock:updated", { entityType: "OF", entityId: "restart-1", locked: true, marker: 3 }, [target]);

    serverB = await startServer();
    const reconnected = await connect(serverB, 11);
    const replayed: Array<Record<string, unknown>> = [];
    reconnected.on("lock:updated", (payload) => replayed.push(payload as Record<string, unknown>));
    await subscribe(reconnected, target);
    const ack = await resume(reconnected, first.sequence);
    expect(ack.ok).toBe(true);
    await eventually(() => expect(replayed).toHaveLength(2));
    expect(replayed.map((payload) => payload.marker)).toEqual([2, 3]);
    expect(new Set(replayed.map((payload) => payload.event_id)).size).toBe(2);
  });

  it("captures a first-session baseline without replaying retained history", async () => {
    controlPlane.suppressEventWakeups = true;
    await controlPlane.publish({
      event: "entity:changed",
      payload: { marker: "historical" },
      targets: [{ scope: "user", userId: 51 }],
      streamId: "user:51",
    });
    const server = await startServer();
    const client = await connect(server, 51);
    const historical = vi.fn();
    client.on("entity:changed", historical);

    await expect(bootstrap(client)).resolves.toEqual({
      ok: true,
      lastSequence: "1",
      truncated: false,
      presenceSnapshot: {
        availability: "known",
        online_user_ids: [51],
        at: expect.any(String),
      },
    });
    expect(historical).not.toHaveBeenCalled();
    await expect(resume(client, 1n)).resolves.toEqual({ ok: true, lastSequence: "1", truncated: false });
  });

  it("never returns an ACK cursor over a stored event with an invalid target", async () => {
    const server = await startServer();
    const client = await connect(server, 52);
    controlPlane.events.push({
      sequence: 1n,
      eventId: "00000000-0000-4000-8000-000000000001",
      streamId: "rt:capability:admin:everything",
      event: "entity:changed",
      payload: { marker: "must-not-be-acknowledged" },
      targets: [{ scope: "capability", capability: "admin:everything" } as unknown as RealtimeSubscription],
      occurredAt: "2026-08-04T10:00:01.000Z",
    });

    await expect(resume(client, 0n)).resolves.toEqual({ ok: false, error: "replay_failed" });
    await expect(bootstrap(client)).resolves.toEqual({ ok: false, error: "replay_failed" });
  });

  it("requires a full resync for an unavailable cursor and accepts the exact retention watermark", async () => {
    const server = await startServer();
    moduleAccess.set(14, new Set(["production"]));
    const target = moduleRealtimeSubscription("production");
    if (!target) throw new Error("Missing production target");
    await controlPlane.publish({ event: "entity:changed", payload: { marker: 1 }, targets: [target], streamId: "module:production" });
    await controlPlane.publish({ event: "entity:changed", payload: { marker: 2 }, targets: [target], streamId: "module:production" });
    await controlPlane.publish({ event: "entity:changed", payload: { marker: 3 }, targets: [target], streamId: "module:production" });
    controlPlane.prunedThrough = 2n;

    const client = await connect(server, 14);
    const events = vi.fn();
    client.on("entity:changed", events);
    await subscribe(client, { scope: "module", moduleKey: "production" });
    await expect(resume(client, 1n)).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: "cursor_too_old",
      fullResyncRequired: true,
      lastSequence: "3",
    }));
    expect(events).not.toHaveBeenCalled();

    await expect(resume(client, 2n)).resolves.toEqual(expect.objectContaining({ ok: true, lastSequence: "3" }));
    await eventually(() => expect(events).toHaveBeenCalledTimes(1));
    expect(events.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ marker: 3, sequence: "3" }));
  });

  it("refuses a cursor beyond the server watermark and supplies a safe baseline", async () => {
    const server = await startServer();
    const client = await connect(server, 141);
    await expect(resume(client, 999n)).resolves.toEqual({
      ok: false,
      error: "cursor_in_future",
      fullResyncRequired: true,
      earliestSequence: null,
      lastSequence: "0",
      presenceSnapshot: {
        availability: "known",
        online_user_ids: [141],
        at: expect.any(String),
      },
    });
  });

  it("does not acknowledge a replay watermark after a transient authorization failure", async () => {
    const server = await startServer();
    moduleAccess.set(15, new Set(["production"]));
    const target = moduleRealtimeSubscription("production");
    if (!target) throw new Error("Missing production target");
    await controlPlane.publish({ event: "entity:changed", payload: { marker: "retry" }, targets: [target], streamId: "module:production" });
    const client = await connect(server, 15);
    const events = vi.fn();
    client.on("entity:changed", events);
    await subscribe(client, { scope: "module", moduleKey: "production" });

    profileFailures.add(15);
    await expect(resume(client, 0n)).resolves.toEqual({ ok: false, error: "replay_failed" });
    expect(events).not.toHaveBeenCalled();

    profileFailures.delete(15);
    await expect(resume(client, 0n)).resolves.toEqual(expect.objectContaining({ ok: true, lastSequence: "1" }));
    await eventually(() => expect(events).toHaveBeenCalledTimes(1));
  });

  it("recovers startup after the bounded retry budget is exhausted", async () => {
    controlPlane.latestSequenceFailures = 3;
    const http = createServer();
    const runtime = createRealtimeSocketRuntime(http, dependencies(), {
      controlPlane,
      startupMaxAttempts: 3,
      startupRetryDelayMs: 1,
      pollIntervalMs: 10_000,
      sessionRevalidationMs: 10_000,
      pruneIntervalMs: 10_000,
    });
    servers.push({ http, runtime, url: "" });

    await expect(runtime.start()).rejects.toThrow("synthetic startup outage");
    expect(runtime.isReady()).toBe(false);
    await eventually(() => expect(runtime.isReady()).toBe(true));
  });

  it("fails closed before accepting sockets when privileged cross-writer backstops are absent", async () => {
    controlPlane.privilegedBackstopsInstalled = false;
    const http = createServer();
    const runtime = createRealtimeSocketRuntime(http, dependencies(), {
      controlPlane,
      startupMaxAttempts: 1,
      startupRetryDelayMs: 1,
      pollIntervalMs: 10_000,
      sessionRevalidationMs: 10_000,
      pruneIntervalMs: 10_000,
    });
    servers.push({ http, runtime, url: "" });

    await expect(runtime.start()).rejects.toThrow("REALTIME_PRIVILEGED_BACKSTOPS_MISSING");
    expect(runtime.getReadiness()).toEqual({
      ready: false,
      controlPlaneReady: false,
      privilegedBackstopsInstalled: false,
    });
    expect(runtime.isReady()).toBe(false);
  });

  it("disconnects every authorized socket, blocks concurrent dispatch, and requires fresh auth after backstops disappear", async () => {
    const server = await startServer({ privilegedBackstopRevalidationMs: 5 });
    moduleAccess.set(70, new Set(["production"]));
    const oldToken = token(70);
    const existingClient = await connect(server, 70, { token: oldToken });
    await subscribe(existingClient, { scope: "module", moduleKey: "production" });
    const events = vi.fn();
    const unavailable = vi.fn();
    existingClient.on("entity:changed", events);
    existingClient.on("realtime:service-unavailable", unavailable);
    controlPlane.privilegedBackstopsInstalled = false;

    const target = moduleRealtimeSubscription("production");
    if (!target) throw new Error("Missing production target");
    await controlPlane.publish({
      event: "entity:changed",
      payload: { marker: "must-not-cross-outage" },
      targets: [target],
      streamId: "module:production",
    });
    await eventually(() => expect(existingClient.connected).toBe(false));
    expect(events).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledWith({ retryable: true });
    expect(server.runtime.isReady()).toBe(false);
    await expect(connectionError(server, 71)).resolves.toMatchObject({ message: "SERVICE_UNAVAILABLE" });
    expect(server.runtime.getMetrics().privilegedBackstopFailures).toBeGreaterThan(0);
    expect(server.runtime.getMetrics().privilegedBackstopSocketsDisconnected).toBe(1);

    controlPlane.privilegedBackstopsInstalled = true;
    await eventually(() => expect(server.runtime.isReady()).toBe(true));
    expect(controlPlane.backstopReconciliations).toBe(1);
    await expectRejected(server, 70, oldToken);
    const freshClient = await connect(server, 70);
    await expect(subscribe(freshClient, { scope: "module", moduleKey: "production" }))
      .resolves.toEqual({ ok: true });
    await expect(resume(freshClient, 0n))
      .resolves.toEqual(expect.objectContaining({ ok: true, lastSequence: "1" }));
    await eventually(() => expect(events).not.toHaveBeenCalled());
    expect(server.runtime.getMetrics().privilegedBackstopRecoveries).toBe(1);
  });

  it("fails readiness on a privileged-backstop query error and recovers after the database check succeeds", async () => {
    const server = await startServer({ privilegedBackstopRevalidationMs: 5 });
    const existingClient = await connect(server, 73);
    controlPlane.privilegedBackstopStatusError = new Error("synthetic backstop query outage");

    await eventually(() => expect(server.runtime.isReady()).toBe(false));
    await eventually(() => expect(existingClient.connected).toBe(false));
    expect(server.runtime.getMetrics().privilegedBackstopFailures).toBeGreaterThan(0);

    controlPlane.privilegedBackstopStatusError = null;
    await eventually(() => expect(server.runtime.isReady()).toBe(true));
    expect(server.runtime.getMetrics().privilegedBackstopRecoveries).toBe(1);
    expect(controlPlane.backstopReconciliations).toBe(1);
  });

  it("fails closed on runtime read/flush outages and recovers only after a successful durable read", async () => {
    const server = await startServer({ pollIntervalMs: 5 });
    moduleAccess.set(72, new Set(["production"]));
    const existingClient = await connect(server, 72);

    for (const outage of ["read", "flush"] as const) {
      controlPlane.readAfterUnavailable = outage === "read";
      controlPlane.flushOutboxUnavailable = outage === "flush";
      await eventually(() => expect(server.runtime.isReady()).toBe(false));
      expect(server.runtime.getReadiness().controlPlaneReady).toBe(false);
      await expect(subscribe(existingClient, { scope: "module", moduleKey: "production" }))
        .resolves.toEqual({ ok: false, error: "authorization_unavailable" });
      await expect(resume(existingClient, 0n))
        .resolves.toEqual({ ok: false, error: "replay_failed" });

      controlPlane.readAfterUnavailable = false;
      controlPlane.flushOutboxUnavailable = false;
      await eventually(() => expect(server.runtime.isReady()).toBe(true));
      expect(server.runtime.getReadiness().controlPlaneReady).toBe(true);
      await expect(subscribe(existingClient, { scope: "module", moduleKey: "production" }))
        .resolves.toEqual({ ok: true });
      await expect(resume(existingClient, 0n))
        .resolves.toEqual({ ok: true, lastSequence: "0", truncated: false });
    }
  });

  it("does not publish startup readiness before the durable replay read succeeds", async () => {
    controlPlane.readAfterUnavailable = true;
    const http = createServer();
    const runtime = createRealtimeSocketRuntime(http, dependencies(), {
      controlPlane,
      startupMaxAttempts: 1,
      startupRetryDelayMs: 1,
      pollIntervalMs: 10_000,
      sessionRevalidationMs: 10_000,
      pruneIntervalMs: 10_000,
    });
    servers.push({ http, runtime, url: "" });

    await expect(runtime.start()).rejects.toThrow("synthetic readAfter outage");
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getReadiness()).toEqual({
      ready: false,
      controlPlaneReady: false,
      privilegedBackstopsInstalled: true,
    });
  });

  it("refuses startup and readiness when durable control-plane integrity is invalid", async () => {
    controlPlane.controlPlaneIntegrityValid = false;
    const http = createServer();
    const runtime = createRealtimeSocketRuntime(http, dependencies(), {
      controlPlane,
      startupMaxAttempts: 1,
      startupRetryDelayMs: 1,
      pollIntervalMs: 10_000,
      sessionRevalidationMs: 10_000,
      pruneIntervalMs: 10_000,
    });
    servers.push({ http, runtime, url: "" });

    await expect(runtime.start()).rejects.toThrow("REALTIME_CONTROL_PLANE_INTEGRITY_FAILED");
    expect(runtime.getReadiness()).toEqual({
      ready: false,
      controlPlaneReady: false,
      privilegedBackstopsInstalled: true,
    });
  });

  it("rejects publish failure and reports it without a false delivery success", async () => {
    const server = await startServer();
    const target = moduleRealtimeSubscription("production");
    if (!target) throw new Error("Missing production target");
    controlPlane.failPublications = 1;
    await expect(server.runtime.publish("entity:changed", { entityType: "OF", entityId: "failure" }, [target]))
      .rejects.toThrow("synthetic publish outage");
    expect(server.runtime.getMetrics()).toEqual(expect.objectContaining({
      publishFailures: 1,
      emissionsDelivered: 0,
      eventsPublished: 0,
    }));
  });

  it("removes a station room after a live role change", async () => {
    const server = await startServer();
    currentRoles.set(12, "Production");
    const client = await connect(server, 12);
    const events = vi.fn();
    client.on("station:event", events);
    const station: RealtimeSubscription = { scope: "station", kind: "STATION", id: "station-a" };
    await expect(subscribe(client, station)).resolves.toEqual({ ok: true });
    currentRoles.set(12, "Employee");
    await server.runtime.publish("station:event", { changed: true }, [station]);
    await eventually(() => expect(server.runtime.getMetrics().emissionRecipientsDenied).toBeGreaterThan(0));
    expect(events).not.toHaveBeenCalled();
  });
});
