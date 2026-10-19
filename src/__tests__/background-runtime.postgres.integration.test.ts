import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import {
  resetBackgroundRuntimeForTests,
  startBackgroundRuntime,
  type BackgroundRuntime,
} from "../shared/runtime/background-runtime";

const databaseUrl = process.env.CERP_BACKGROUND_RUNTIME_TEST_DATABASE_URL;
const describePostgres = databaseUrl && /(?:localhost|127\.0\.0\.1).*cerp_background_runtime_test/i.test(databaseUrl)
  ? describe
  : describe.skip;

describePostgres("background runtime PostgreSQL leadership", () => {
  const pools: Pool[] = [];
  const runtimes: BackgroundRuntime[] = [];

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("CERP_BACKGROUND_RUNTIME_TEST_DATABASE_URL is required");
  });

  afterAll(async () => {
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    await Promise.all(pools.map((pool) => pool.end()));
    resetBackgroundRuntimeForTests();
  }, 15_000);

  it("elects one cross-process leader and transfers only after orderly release", async () => {
    const firstPool = new Pool({ connectionString: databaseUrl });
    const secondPool = new Pool({ connectionString: databaseUrl });
    pools.push(firstPool, secondPool);
    const firstMaintenance = vi.fn(() => []);
    const secondMaintenance = vi.fn(() => []);
    const environment = { CERP_RUNTIME_ROLE: "worker", CERP_BACKGROUND_LEADER_RETRY_MS: "1000" };
    const first = startBackgroundRuntime({ pool: firstPool, startMaintenance: firstMaintenance, environment });
    const second = startBackgroundRuntime({ pool: secondPool, startMaintenance: secondMaintenance, environment });
    runtimes.push(first, second);

    // A real PostgreSQL container may need to accept the first session before
    // the one-second leadership retry is observable; production behavior is
    // unchanged and the test remains bounded.
    await vi.waitFor(() => expect(firstMaintenance).toHaveBeenCalledOnce(), { timeout: 15_000 });
    expect(secondMaintenance).not.toHaveBeenCalled();
    await first.stop();
    await vi.waitFor(() => expect(secondMaintenance).toHaveBeenCalledOnce(), { timeout: 15_000 });
    await second.stop();
  }, 15_000);

  it("does not transfer leadership until an active maintenance cycle drains", async () => {
    const firstPool = new Pool({ connectionString: databaseUrl });
    const secondPool = new Pool({ connectionString: databaseUrl });
    pools.push(firstPool, secondPool);
    let releaseCycle!: () => void;
    const cycleDrained = new Promise<void>((resolve) => { releaseCycle = resolve; });
    const firstMaintenance = vi.fn(() => [async () => { await cycleDrained; }]);
    const secondMaintenance = vi.fn(() => []);
    const environment = { CERP_RUNTIME_ROLE: "worker", CERP_BACKGROUND_LEADER_RETRY_MS: "1000" };
    const first = startBackgroundRuntime({ pool: firstPool, startMaintenance: firstMaintenance, environment });
    const second = startBackgroundRuntime({ pool: secondPool, startMaintenance: secondMaintenance, environment });
    runtimes.push(first, second);

    await vi.waitFor(() => expect(firstMaintenance).toHaveBeenCalledOnce(), { timeout: 15_000 });
    const drainingStop = first.stop();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(secondMaintenance).not.toHaveBeenCalled();
    releaseCycle();
    await drainingStop;
    await vi.waitFor(() => expect(secondMaintenance).toHaveBeenCalledOnce(), { timeout: 15_000 });
    await second.stop();
  }, 15_000);
});