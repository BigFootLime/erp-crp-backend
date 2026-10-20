import { describe, expect, it, vi } from "vitest";

import { startDrainingInterval, startMaintenanceGroup } from "../shared/runtime/drainable-maintenance";

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

  it("drains services that started before a later startup failure", async () => {
    const firstStop = vi.fn(async () => undefined);
    const secondStop = vi.fn(async () => undefined);

    await expect(startMaintenanceGroup([
      () => firstStop,
      () => secondStop,
      () => { throw new Error("third service failed"); },
    ])).rejects.toThrow("third service failed");

    expect(secondStop).toHaveBeenCalledOnce();
    expect(firstStop).toHaveBeenCalledOnce();
    expect(secondStop.mock.invocationCallOrder[0]).toBeLessThan(firstStop.mock.invocationCallOrder[0]);
  });
});
