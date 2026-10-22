import { afterEach, describe, expect, it, vi } from "vitest";

import { startMfaArtifactMaintenance } from "./mfa.service";

describe("MFA artifact maintenance drain", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for the active expired-artifact cleanup and never starts a later cycle after stop", async () => {
    vi.useFakeTimers();
    let releaseCleanup: ((value: { challengesDeleted: number; pendingFactorsDeleted: number }) => void) | undefined;
    const cleanup = vi.fn(() => new Promise<{ challengesDeleted: number; pendingFactorsDeleted: number }>((resolve) => {
      releaseCleanup = resolve;
    }));
    const stop = startMfaArtifactMaintenance(1_000, { cleanup });

    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledOnce();

    const stopping = stop();
    let settled = false;
    void Promise.resolve(stopping).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    releaseCleanup?.({ challengesDeleted: 0, pendingFactorsDeleted: 0 });
    await stopping;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
