import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBackgroundRuntimeReadiness,
  resetBackgroundRuntimeForTests,
  resolveRuntimeRole,
  startBackgroundRuntime,
} from "../shared/runtime/background-runtime";
import { workerHealthResponse } from "../shared/runtime/worker-health-server";

type Listener = () => void;

class AdvisoryDatabase {
  locked = false;
  readonly clients: AdvisoryClient[] = [];

  connect = async (): Promise<AdvisoryClient> => {
    const client = new AdvisoryClient(this);
    this.clients.push(client);
    return client;
  };
}

class AdvisoryClient {
  private readonly listeners = new Set<Listener>();
  released = false;
  destroyed = false;

  constructor(private readonly database: AdvisoryDatabase) {}

  async query<T extends { acquired?: boolean }>(sql: string): Promise<{ rows: T[] }> {
    if (sql.includes("pg_try_advisory_lock")) {
      if (this.database.locked) return { rows: [{ acquired: false } as T] };
      this.database.locked = true;
      return { rows: [{ acquired: true } as T] };
    }
    if (sql.includes("pg_advisory_unlock")) this.database.locked = false;
    return { rows: [] };
  }

  release(destroy = false): void {
    this.released = true;
    this.destroyed = Boolean(destroy);
    this.database.locked = false;
  }

  on(event: string, listener: Listener): void {
    if (event === "error") this.listeners.add(listener);
  }

  fail(): void {
    for (const listener of this.listeners) listener();
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  resetBackgroundRuntimeForTests();
});

describe("background runtime roles", () => {
  it("keeps default compatibility and rejects an unknown role", () => {
    expect(resolveRuntimeRole({})).toBe("all");
    expect(resolveRuntimeRole({ CERP_RUNTIME_ROLE: "API" })).toBe("api");
    expect(() => resolveRuntimeRole({ CERP_RUNTIME_ROLE: "sidecar" })).toThrow("CERP_RUNTIME_ROLE_INVALID");
  });

  it("waits for a pending leadership attempt before shutdown and never starts maintenance", async () => {
    const database = new AdvisoryDatabase();
    let resolveConnect!: (client: AdvisoryClient) => void;
    const connect = vi.fn(() => new Promise<AdvisoryClient>((resolve) => { resolveConnect = resolve; }));
    const startMaintenance = vi.fn(() => []);
    const runtime = startBackgroundRuntime({
      pool: { connect },
      startMaintenance,
      environment: { CERP_RUNTIME_ROLE: "worker" },
    });

    const stopping = runtime.stop();
    await Promise.resolve();
    expect(startMaintenance).not.toHaveBeenCalled();
    const client = new AdvisoryClient(database);
    resolveConnect(client);
    await stopping;

    expect(client.released).toBe(true);
    expect(startMaintenance).not.toHaveBeenCalled();
    expect(getBackgroundRuntimeReadiness()).toMatchObject({ worker_state: "stopped" });
  });

  it("releases an advisory lock acquired while shutdown is waiting", async () => {
    const database = new AdvisoryDatabase();
    const client = new AdvisoryClient(database);
    let resolveLock!: (value: { rows: Array<{ acquired: boolean }> }) => void;
    const query = vi.fn((sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return new Promise<{ rows: Array<{ acquired: boolean }> }>((resolve) => { resolveLock = resolve; });
      }
      return Promise.resolve({ rows: [] });
    });
    client.query = query;
    const startMaintenance = vi.fn(() => []);
    const runtime = startBackgroundRuntime({
      pool: { connect: async () => client },
      startMaintenance,
      environment: { CERP_RUNTIME_ROLE: "worker" },
    });

    await Promise.resolve();
    const stopping = runtime.stop();
    resolveLock({ rows: [{ acquired: true }] });
    await stopping;

    expect(startMaintenance).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_unlock"), expect.any(Array));
    expect(client.released).toBe(true);
    expect(getBackgroundRuntimeReadiness()).toMatchObject({ worker_state: "stopped" });
  });

  it("drains maintenance that finishes starting while shutdown is in progress", async () => {
    const database = new AdvisoryDatabase();
    let finishStartup!: (stops: readonly (() => Promise<void>)[]) => void;
    const startup = new Promise<readonly (() => Promise<void>)[]>((resolve) => { finishStartup = resolve; });
    const stopMaintenance = vi.fn(async () => undefined);
    const startMaintenance = vi.fn(() => startup);
    const runtime = startBackgroundRuntime({
      pool: database,
      startMaintenance,
      environment: { CERP_RUNTIME_ROLE: "worker" },
    });

    await vi.waitFor(() => expect(startMaintenance).toHaveBeenCalledOnce());
    const stopping = runtime.stop();
    finishStartup([stopMaintenance]);
    await stopping;

    expect(stopMaintenance).toHaveBeenCalledOnce();
    expect(database.clients[0].released).toBe(true);
    expect(getBackgroundRuntimeReadiness()).toMatchObject({ worker_state: "stopped" });
  });

  it("does not replace stopped state when a delayed leadership attempt fails", async () => {
    let rejectConnect!: (error: Error) => void;
    const runtime = startBackgroundRuntime({
      pool: { connect: () => new Promise<AdvisoryClient>((_resolve, reject) => { rejectConnect = reject; }) },
      startMaintenance: () => [],
      environment: { CERP_RUNTIME_ROLE: "worker" },
    });

    const stopping = runtime.stop();
    rejectConnect(new Error("connection unavailable"));
    await stopping;

    expect(getBackgroundRuntimeReadiness()).toMatchObject({ worker_state: "stopped", ready: false });
  });

  it("destroys the leader session when maintenance startup fails after lock acquisition", async () => {
    const database = new AdvisoryDatabase();
    const startMaintenance = vi.fn(async () => { throw new Error("maintenance startup failed"); });
    const runtime = startBackgroundRuntime({
      pool: database,
      startMaintenance,
      environment: { CERP_RUNTIME_ROLE: "worker" },
    });

    await vi.waitFor(() => expect(database.clients[0]?.destroyed).toBe(true));
    expect(database.locked).toBe(false);
    await runtime.stop();
  });

  it("keeps the historical all role by acquiring leadership and starting maintenance", async () => {
    const database = new AdvisoryDatabase();
    const startMaintenance = vi.fn(() => []);
    const runtime = startBackgroundRuntime({ pool: database, startMaintenance, environment: {} });

    await settle();
    expect(runtime.role).toBe("all");
    expect(database.clients).toHaveLength(1);
    expect(startMaintenance).toHaveBeenCalledOnce();
    expect(getBackgroundRuntimeReadiness()).toMatchObject({ role: "all", worker_state: "leader", maintenance_enabled: true, ready: true });
    await runtime.stop();
  });
  it("reports worker readiness through the private health surface", async () => {
    const database = new AdvisoryDatabase();
    const runtime = startBackgroundRuntime({
      pool: database,
      startMaintenance: () => [],
      environment: { CERP_RUNTIME_ROLE: "worker" },
    });

    expect(workerHealthResponse("GET", "/health/ready").statusCode).toBe(503);
    await settle();
    expect(workerHealthResponse("GET", "/health/ready")).toMatchObject({ statusCode: 200 });
    expect(JSON.parse(workerHealthResponse("GET", "/health/ready").body)).toMatchObject({
      background_runtime: { worker_state: "leader", ready: true },
    });
    expect(workerHealthResponse("GET", "/api/v1/users").statusCode).toBe(404);
    await runtime.stop();
  });
  it("starts no worker database connection or job in api mode", async () => {
    const database = new AdvisoryDatabase();
    const startMaintenance = vi.fn(() => []);
    const runtime = startBackgroundRuntime({
      pool: database,
      startMaintenance,
      environment: { CERP_RUNTIME_ROLE: "api" },
    });

    await settle();
    expect(runtime.role).toBe("api");
    expect(database.clients).toHaveLength(0);
    expect(startMaintenance).not.toHaveBeenCalled();
    expect(getBackgroundRuntimeReadiness()).toMatchObject({ role: "api", maintenance_enabled: false, ready: true });
    await runtime.stop();
  });

  it("allows exactly one worker leader and fails over only after its release", async () => {
    vi.useFakeTimers();
    const database = new AdvisoryDatabase();
    const firstStart = vi.fn(() => [vi.fn()]);
    const secondStart = vi.fn(() => [vi.fn()]);
    const environment = { CERP_RUNTIME_ROLE: "worker", CERP_BACKGROUND_LEADER_RETRY_MS: "1000" };
    const first = startBackgroundRuntime({ pool: database, startMaintenance: firstStart, environment });
    const second = startBackgroundRuntime({ pool: database, startMaintenance: secondStart, environment });

    await settle();
    expect(firstStart).toHaveBeenCalledOnce();
    expect(secondStart).not.toHaveBeenCalled();
    await first.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(secondStart).toHaveBeenCalledOnce();
    expect(getBackgroundRuntimeReadiness()).toMatchObject({ role: "worker", worker_state: "leader", maintenance_enabled: true });
    await second.stop();
  });

  it("stops maintenance and invokes the fatal path if the leader connection fails", async () => {
    const database = new AdvisoryDatabase();
    const stopMaintenance = vi.fn();
    const onLeadershipLost = vi.fn();
    const runtime = startBackgroundRuntime({
      pool: database,
      startMaintenance: () => [stopMaintenance],
      environment: { CERP_RUNTIME_ROLE: "worker" },
      onLeadershipLost,
    });

    await settle();
    database.clients[0].fail();
    await vi.waitFor(() => expect(stopMaintenance).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(onLeadershipLost).toHaveBeenCalledOnce());
    expect(getBackgroundRuntimeReadiness()).toMatchObject({ worker_state: "lost", ready: false });
    await runtime.stop();
  });
});
