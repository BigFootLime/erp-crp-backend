import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBackgroundLifecycle } from "./background-lifecycle";

const databaseUrl = process.env.CERP_BG_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("background worker PostgreSQL leader election", () => {
  const pools: Pool[] = [];
  const lifecycles: Array<ReturnType<typeof startBackgroundLifecycle>> = [];

  afterEach(async () => {
    await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.stop()));
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it("holds work on one connection, then elects the waiting colour after release", async () => {
    const firstPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const secondPool = new Pool({ connectionString: databaseUrl, max: 2 });
    pools.push(firstPool, secondPool);
    const firstStart = vi.fn(() => vi.fn());
    const secondStart = vi.fn(() => vi.fn());
    let retrySecond: (() => void) | undefined;

    const first = startBackgroundLifecycle({
      pool: firstPool,
      starters: [firstStart],
      env: { CERP_BACKGROUND_WORKERS: "leader" },
      retryMs: 60_000,
    });
    lifecycles.push(first);
    await vi.waitFor(() => expect(firstStart).toHaveBeenCalledTimes(1));

    const second = startBackgroundLifecycle({
      pool: secondPool,
      starters: [secondStart],
      env: { CERP_BACKGROUND_WORKERS: "leader" },
      retryMs: 60_000,
      setInterval: ((callback: () => void) => {
        retrySecond = callback;
        return {} as NodeJS.Timeout;
      }) as typeof setInterval,
      clearInterval: () => undefined,
    });
    lifecycles.push(second);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(secondStart).not.toHaveBeenCalled();

    await first.stop();
    retrySecond?.();
    await vi.waitFor(() => expect(secondStart).toHaveBeenCalledTimes(1));
  });
});
