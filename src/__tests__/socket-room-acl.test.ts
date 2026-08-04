import { createServer, type Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  emitToAuthorizedSubscribers,
  getRealtimeSecurityMetrics,
  initSocketServer,
  type SocketAuthorizationDependencies,
} from "../sockets/sockeServer";
import {
  REALTIME_CAPABILITIES,
  entityRealtimeSubscription,
  moduleRealtimeSubscription,
  type RealtimeSubscription,
} from "../shared/realtime/realtime-room-policy";

const JWT_SECRET = "local-socket-acl-test-secret";

type Ack = { ok: boolean; error?: string };

describe("Socket.IO room ACL", () => {
  let httpServer: HttpServer;
  let url: string;
  const clients: ClientSocket[] = [];
  const activeUsers = new Set<number>();
  const moduleAccess = new Map<number, Set<string>>();
  const superadmins = new Set<number>();
  const currentRoles = new Map<number, string>();

  const dependencies: Partial<SocketAuthorizationDependencies> = {
    loadAccountAuthorization: async (userId) => {
      const role = currentRoles.get(userId) ?? "Employee";
      return activeUsers.has(userId)
        ? { active: true, role, primaryRole: role, roles: [role] }
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

  beforeEach(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    activeUsers.clear();
    moduleAccess.clear();
    superadmins.clear();
    currentRoles.clear();
    httpServer = createServer();
    initSocketServer(httpServer, dependencies);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Test server address unavailable");
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    await new Promise<void>((resolve) => {
      if (!httpServer.listening) return resolve();
      httpServer.close(() => resolve());
    });
    vi.restoreAllMocks();
  });

  function token(userId: number, expiresIn: number | string = "5m"): string {
    return jwt.sign(
      { id: userId, role: "Employee", primary_role: "Employee", roles: ["Employee"] },
      JWT_SECRET,
      { expiresIn: expiresIn as jwt.SignOptions["expiresIn"] }
    );
  }

  async function clientFor(userId: number, expiresIn: number | string = "5m"): Promise<ClientSocket> {
    activeUsers.add(userId);
    const client = connectClient(url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth: { token: token(userId, expiresIn) },
    });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });
    return client;
  }

  async function subscribe(client: ClientSocket, subscription: unknown): Promise<Ack> {
    return new Promise<Ack>((resolve) => {
      client.emit("room:subscribe", subscription, (ack: Ack | undefined) => {
        resolve(ack ?? { ok: false, error: "missing_ack" });
      });
    });
  }

  async function emitEvent(event: string, payload: unknown, targets: RealtimeSubscription[]) {
    await emitToAuthorizedSubscribers(event, payload, targets);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  it("rejects raw, unknown and cross-module subscriptions by default", async () => {
    moduleAccess.set(1, new Set(["production"]));
    const client = await clientFor(1);

    await expect(subscribe(client, { room: "erp:global" })).resolves.toEqual({
      ok: false,
      error: "invalid_subscription",
    });
    await expect(subscribe(client, { scope: "module", moduleKey: "production" })).resolves.toEqual({ ok: true });
    await expect(subscribe(client, { scope: "module", moduleKey: "qualite" })).resolves.toEqual({
      ok: false,
      error: "forbidden",
    });
    await expect(subscribe(client, { scope: "entity", entityType: "NCR", entityId: "nc-1" })).resolves.toEqual({
      ok: false,
      error: "forbidden",
    });
    await expect(subscribe(client, { scope: "entity", entityType: "UNKNOWN", entityId: "1" })).resolves.toEqual({
      ok: false,
      error: "invalid_subscription",
    });
    await expect(subscribe(client, { scope: "user", userId: 1 })).resolves.toEqual({
      ok: false,
      error: "invalid_subscription",
    });
  });

  it("delivers once to the minimum authorized union and never across role/entity scopes", async () => {
    moduleAccess.set(1, new Set(["production"]));
    moduleAccess.set(2, new Set(["qualite"]));
    const productionClient = await clientFor(1);
    const qualityClient = await clientFor(2);
    const productionEvents = vi.fn();
    const qualityEvents = vi.fn();
    productionClient.on("entity:changed", productionEvents);
    qualityClient.on("entity:changed", qualityEvents);

    await subscribe(productionClient, { scope: "module", moduleKey: "production" });
    await subscribe(productionClient, { scope: "entity", entityType: "OF", entityId: "42" });
    await subscribe(qualityClient, { scope: "entity", entityType: "NCR", entityId: "nc-1" });

    const productionModule = moduleRealtimeSubscription("production");
    const of42 = entityRealtimeSubscription("OF", "42");
    if (!productionModule || !of42) throw new Error("Missing production test targets");
    await emitEvent("entity:changed", { entityType: "OF", entityId: "42" }, [productionModule, of42]);
    expect(productionEvents).toHaveBeenCalledTimes(1);
    expect(qualityEvents).not.toHaveBeenCalled();

    const of43 = entityRealtimeSubscription("OF", "43");
    if (!of43) throw new Error("Missing OF test target");
    await emitEvent("lock:updated", { entityType: "OF", entityId: "43" }, [of43]);
    expect(productionEvents).toHaveBeenCalledTimes(1);
    expect(qualityEvents).not.toHaveBeenCalled();
  });

  it("revalidates a revoked capability at emission and denies subsequent joins", async () => {
    moduleAccess.set(3, new Set(["production"]));
    const client = await clientFor(3);
    const events = vi.fn();
    client.on("entity:changed", events);
    await expect(subscribe(client, { scope: "module", moduleKey: "production" })).resolves.toEqual({ ok: true });

    moduleAccess.set(3, new Set());
    const production = moduleRealtimeSubscription("production");
    if (!production) throw new Error("Missing production target");
    await emitEvent("entity:changed", { entityType: "OF", entityId: "1" }, [production]);
    expect(events).not.toHaveBeenCalled();
    expect(getRealtimeSecurityMetrics().emissionRecipientsDenied).toBeGreaterThan(0);
    await expect(subscribe(client, { scope: "module", moduleKey: "production" })).resolves.toEqual({
      ok: false,
      error: "forbidden",
    });

    client.disconnect();
    moduleAccess.set(3, new Set(["production"]));
    const reconnected = await clientFor(3);
    await expect(subscribe(reconnected, { scope: "module", moduleKey: "production" })).resolves.toEqual({ ok: true });
  });

  it("reloads a changed role and removes a station subscription before emission", async () => {
    currentRoles.set(7, "Production");
    const client = await clientFor(7);
    const stationEvents = vi.fn();
    client.on("station:event", stationEvents);
    const station: RealtimeSubscription = { scope: "station", kind: "STATION", id: "station-a" };
    await expect(subscribe(client, station)).resolves.toEqual({ ok: true });

    currentRoles.set(7, "Employee");
    await emitEvent("station:event", { changed: true }, [station]);
    expect(stationEvents).not.toHaveBeenCalled();

    client.disconnect();
    const reconnected = await clientFor(7);
    await expect(subscribe(reconnected, station)).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("keeps user and audit events inside server-assigned rooms", async () => {
    superadmins.add(4);
    const admin = await clientFor(4);
    const employee = await clientFor(5);
    const adminNotification = vi.fn();
    const employeeNotification = vi.fn();
    const adminAudit = vi.fn();
    const employeeAudit = vi.fn();
    admin.on("app-notification:created", adminNotification);
    employee.on("app-notification:created", employeeNotification);
    admin.on("audit:new", adminAudit);
    employee.on("audit:new", employeeAudit);

    await emitEvent("app-notification:created", { id: "n-1" }, [{ scope: "user", userId: 4 }]);
    await emitEvent("audit:new", { auditId: "a-1" }, [
      { scope: "capability", capability: REALTIME_CAPABILITIES.AUDIT_READ },
    ]);

    expect(adminNotification).toHaveBeenCalledTimes(1);
    expect(employeeNotification).not.toHaveBeenCalled();
    expect(adminAudit).toHaveBeenCalledTimes(1);
    expect(employeeAudit).not.toHaveBeenCalled();
  });

  it("disconnects an expired JWT instead of retaining stale room access", async () => {
    moduleAccess.set(6, new Set(["production"]));
    const client = await clientFor(6, 1);
    await expect(subscribe(client, { scope: "module", moduleKey: "production" })).resolves.toEqual({ ok: true });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("expiry disconnect timeout")), 2500);
      client.once("disconnect", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    expect(getRealtimeSecurityMetrics().expiredSessionsDisconnected).toBeGreaterThan(0);
  });
});
