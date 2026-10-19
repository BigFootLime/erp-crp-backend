import { describe, expect, it, vi } from "vitest";

import { startDrainingInterval } from "../shared/runtime/drainable-maintenance";

describe("drainable maintenance", () => {
  it("blocks new cycles and waits for the active cycle during drain", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    const cycle = vi.fn(async () => { await active; });
    const stop = startDrainingInterval(cycle, 1_000, { immediate: true });

    await Promise.resolve();
    await Promise.resolve();
    expect(cycle).toHaveBeenCalledOnce();
    const draining = stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cycle).toHaveBeenCalledOnce();
    release();
    await draining;
    vi.useRealTimers();
  });
});
