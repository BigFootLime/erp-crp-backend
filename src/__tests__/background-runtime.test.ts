import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBackgroundRuntimeReadiness,
  resetBackgroundRuntimeForTests,
  resolveRuntimeRole,
  startBackgroundRuntime,
} from "../shared/runtime/background-runtime";

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

  release(): void {
    this.released = true;
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