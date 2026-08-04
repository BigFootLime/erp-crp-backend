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
} from "../shared/realtime/realtime-control-plane";
import {
  REALTIME_CAPABILITIES,
  entityRealtimeSubscription,
  moduleRealtimeSubscription,
  type RealtimeSubscription,
} from "../shared/realtime/realtime-room-policy";

const JWT_SECRET = "local-socket-acl-test-secret";

type Ack = { ok: boolean; error?: string };
type ResumeAck = { ok: boolean; error?: string; lastSequence?: string; truncated?: boolean };
type RunningServer = { http: HttpServer; runtime: RealtimeSocketRuntime; url: string };

class SharedMemoryControlPlane implements RealtimeControlPlane {
  readonly events: RealtimeEventRecord[] = [];
  readonly epochs = new Map<number, number>();
  failPublications = 0;
  duplicateWakeups = false;
  suppressEventWakeups = false;
  private readonly listeners = new Set<(signal: RealtimeControlSignal) => void>();
  private readonly deduplication = new Map<string, RealtimeEventRecord>();
  private nextSequence = 1n;

  async latestSequence(): Promise<bigint> {
    return this.events.at(-1)?.sequence ?? 0n;
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
    return this.events.filter((event) => event.sequence > sequence).slice(0, limit);
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
  let controlPlane: SharedMemoryControlPlane;

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    activeUsers.clear();
    moduleAccess.clear();
    superadmins.clear();
    currentRoles.clear();
    authorizationFailures.clear();
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
      resolveAccountAccessProfile: async (userId) => ({
        is_superadmin: superadmins.has(userId),
        modules: [...(moduleAccess.get(userId) ?? new Set<string>())].map((moduleKey) => ({
          module_key: moduleKey,
          label: moduleKey,
          nav_page_keys: [],
          allowed: true,
          source: "DEFAULT" as const,
        })),
      }),
      authorizeStationSubscription: async (_subscription, user) => user.role === "Production",
    };
  }

  async function startServer(options: { pollIntervalMs?: number } = {}): Promise<RunningServer> {
    const http = createServer();
    const runtime = createRealtimeSocketRuntime(http, dependencies(), {
      controlPlane,
      pollIntervalMs: options.pollIntervalMs ?? 10_000,
      sessionRevalidationMs: 10_000,
      pruneIntervalMs: 10_000,
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
