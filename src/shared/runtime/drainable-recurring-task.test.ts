import { describe, expect, it, vi } from "vitest";
import { startDrainableRecurringTask } from "./drainable-recurring-task";

describe("drainable recurring task", () => {
  it("prevents a new cycle and waits for the active cycle", async () => {
    let finish: (() => void) | undefined;
    const cycle = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const task = startDrainableRecurringTask(cycle, 60_000);
    await vi.waitFor(() => expect(cycle).toHaveBeenCalledTimes(1));
    const stopping = task.stop();
    expect(cycle).toHaveBeenCalledTimes(1);
    let settled = false;
    void stopping.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    finish?.();
    await stopping;
    expect(settled).toBe(true);
  });

  it("reports overlap and an unhandled cycle failure to explicit callbacks", async () => {
    const overlap = vi.fn();
    const error = vi.fn();
    let reject: ((reason?: unknown) => void) | undefined;
    const task = startDrainableRecurringTask(
      () => new Promise<void>((_resolve, fail) => { reject = fail; }),
      1,
      { onOverlap: overlap, onError: error }
    );
    await vi.waitFor(() => expect(overlap).toHaveBeenCalled());
    reject?.(new Error("synthetic"));
    await task.stop();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
