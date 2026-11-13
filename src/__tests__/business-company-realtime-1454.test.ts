import { createServer, type Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import {
  io as connectClient,
  type Socket as ClientSocket,
} from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeCompany = vi.hoisted(() => ({
  enabled: true,
  access: vi.fn(),
}));

vi.mock("../shared-directory/site-runtime", () => ({
  sharedDirectoryClient: () => null,
  validateSiteDirectoryToken: vi.fn(),
}));
vi.mock("../module/entreprises/runtime/company-runtime.service", () => ({
  companyRuntimeService: {
    configuration: () =>
      runtimeCompany.enabled
        ? {
            enabled: true,
            company_id: "22222222-2222-4222-8222-222222222222",
            environment: "cerp_prod",
          }
        : { enabled: false },
    access: runtimeCompany.access,
  },
}));

import {
  createRealtimeSocketRuntime,
  type RealtimeSocketRuntime,
  type SocketAuthorizationDependencies,
} from "../sockets/sockeServer";
import type {
  RealtimeControlPlane,
  RealtimeControlSignal,
} from "../shared/realtime/realtime-control-plane";

const secret = "business-company-realtime-test-secret";
const companyId = "22222222-2222-4222-8222-222222222222";
type Ack = { ok: boolean; error?: string };
type Running = {
  http: HttpServer;
  runtime: RealtimeSocketRuntime;
  url: string;
};

class MemoryControlPlane implements RealtimeControlPlane {
  async latestSequence() {
    return 0n;
  }
  async validatedLatestSequence() {
    return 0n;
  }
  async readAfter() {
    return [];
  }
  async flushOutbox() {
    return 0;
  }
  async pruneExpired() {
    return 0;
  }
  async publish() {
    throw new Error("not used by this ACL test");
  }
  async revokeSessions() {
    return 0;
  }
  async subscribe(_listener: (signal: RealtimeControlSignal) => void) {
    return async () => undefined;
  }
  async integrityStatus() {
    return {
      valid: true,
      stateValid: true,
      provenanceValid: true,
      sequenceDefaultRemoved: true,
      constraintsValid: true,
    };
  }
  async privilegedBackstopStatus() {
    return { installed: true, expectedCount: 1, installedCount: 1 };
  }
}

describe("business-company Socket.IO boundary", () => {
  const clients: ClientSocket[] = [];
  const servers: Running[] = [];
  let membershipLive = true;

  beforeEach(() => {
    process.env.JWT_SECRET = secret;
    membershipLive = true;
    runtimeCompany.enabled = true;
    runtimeCompany.access.mockReset();
    runtimeCompany.access.mockImplementation(async () => {
      if (!membershipLive)
        throw Object.assign(new Error("membership revoked"), { status: 403 });
      return {
        context: {
          central_account_id: 7,
          directory_profile_id: "33333333-3333-4333-8333-333333333333",
          company_id: companyId,
          environment: "cerp_prod",
          profile: "COMMERCIAL",
          workspace: "ACCUEIL",
          module_keys: ["clients", "commandes-clients"],
          commercial_projection_capabilities: [],
        },
      };
    });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    for (const server of servers.splice(0)) {
      await server.runtime.stop();
      await new Promise<void>((resolve) => server.http.close(() => resolve()));
    }
    vi.restoreAllMocks();
  });

  async function start(): Promise<Running> {
    const dependencies: Partial<SocketAuthorizationDependencies> = {
      loadAccountAuthorization: async () => ({
        active: true,
        role: "Administrateur Systeme et Reseau",
        primaryRole: "Administrateur Systeme et Reseau",
        roles: ["Administrateur Systeme et Reseau"],
        sessionEpoch: 0,
        mfaRequired: false,
        mfaFactorId: null,
        mfaFactorVersion: null,
      }),
      resolveAccountAccessProfile: async () => ({
        is_superadmin: true,
        modules: [
          "clients",
          "commandes-clients",
          "production",
          "stock",
          "administration",
        ].map((module_key) => ({
          module_key,
          allowed: true,
        })),
      }),
      resolveSensitiveCapabilities: async () => ({
        active: true,
        isSuperadmin: true,
        capabilities: ["audit.read"],
      }),
      authorizeStationSubscription: async () => true,
    };
    const http = createServer();
    const runtime = createRealtimeSocketRuntime(http, dependencies, {
      controlPlane: new MemoryControlPlane(),
      sessionRevalidationMs: 20,
      pollIntervalMs: 10_000,
      pruneIntervalMs: 10_000,
      privilegedBackstopRevalidationMs: 10_000,
    });
    await runtime.start();
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string")
      throw new Error("missing local address");
    const running = { http, runtime, url: `http://127.0.0.1:${address.port}` };
    servers.push(running);
    return running;
  }

  function signedToken() {
    return jwt.sign(
      {
        id: 7,
        role: "Administrateur Systeme et Reseau",
        session_epoch: 0,
        jti: "00000000-0000-4000-8000-000000000007",
      },
      secret,
      { expiresIn: "5m" },
    );
  }

  async function connect(
    server: Running,
    company?: string,
  ): Promise<ClientSocket> {
    const client = connectClient(server.url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth: { token: signedToken() },
      query: company === undefined ? {} : { company, database: "cerp_prod" },
    });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });
    return client;
  }

  async function rejected(server: Running, company?: string, database: string | undefined = "cerp_prod"): Promise<Error> {
    const client = connectClient(server.url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth: { token: signedToken() },
      query: company === undefined ? {} : { company, ...(database === undefined ? {} : { database }) },
    });
    clients.push(client);
    return new Promise((resolve) => client.once("connect_error", resolve));
  }

  function subscribe(client: ClientSocket, payload: unknown): Promise<Ack> {
    return new Promise((resolve) =>
      client.emit("room:subscribe", payload, (ack: Ack) => resolve(ack)),
    );
  }

  async function eventually(assertion: () => void, timeoutMs = 1_000) {
    const startAt = Date.now();
    while (true) {
      try {
        assertion();
        return;
      } catch (error) {
        if (Date.now() - startAt >= timeoutMs) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }

  it("requires the fixed company handshake even for a valid central JWT", async () => {
    const server = await start();
    await expect(rejected(server)).resolves.toMatchObject({
      message: "UNAUTHORIZED",
    });
    await expect(
      rejected(server, "11111111-1111-4111-8111-111111111111"),
    ).resolves.toMatchObject({ message: "UNAUTHORIZED" });
    for (const environment of ["cerp_test", "cerp_company_22222222222242228222222222222222_prod", ""]) {
      await expect(rejected(server, companyId, environment)).resolves.toMatchObject({ message: "UNAUTHORIZED" });
    }
  });

  it("keeps the one physical runtime but filters rooms from the server-revalidated commercial context", async () => {
    const server = await start();
    const client = await connect(server, companyId);
    await eventually(() => expect(runtimeCompany.access).toHaveBeenCalled());
    const rooms = [...server.runtime.io.sockets.sockets.values()][0]?.rooms;
    expect(rooms).toContain("rt:user:7");
    expect(rooms).not.toContain("rt:capability:audit:read");
    await expect(
      subscribe(client, { scope: "module", moduleKey: "clients" }),
    ).resolves.toEqual({ ok: true });
    await expect(
      subscribe(client, { scope: "module", moduleKey: "production" }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
    await expect(
      subscribe(client, { scope: "module", moduleKey: "stock" }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
    await expect(
      subscribe(client, { scope: "station", kind: "STATION", id: "station-1" }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("disconnects on the next bounded revalidation when company membership is revoked", async () => {
    const server = await start();
    const client = await connect(server, companyId);
    const revoked = vi.fn();
    client.on("realtime:session-revoked", revoked);
    membershipLive = false;
    await eventually(() =>
      expect(revoked).toHaveBeenCalledWith({ code: "ACCOUNT_CHANGED" }),
    );
    await eventually(() => expect(client.connected).toBe(false));
  });
});
