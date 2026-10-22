export type DrainableRecurringTask = Readonly<{
  stop: () => Promise<void>;
}>;

/**
 * Serializes a periodic task. stop() first prevents new cycles, clears the
 * timer, then waits for the active promise. It cannot cancel I/O already sent;
 * callers still need idempotent/fenced business operations for partition-safe
 * delivery.
 */
export function startDrainableRecurringTask(
  cycle: () => Promise<void>,
  intervalMs: number,
  options: Readonly<{ immediate?: boolean; onOverlap?: () => void; onError?: (error: unknown) => void }> = {}
): DrainableRecurringTask {
  let stopped = false;
  let active: Promise<void> | null = null;
  const run = (): void => {
    if (stopped) return;
    if (active) {
      options.onOverlap?.();
      return;
    }
    active = Promise.resolve().then(cycle).catch((error: unknown) => {
      if (options.onError) options.onError(error);
      else console.error(JSON.stringify({ type: "drainable_recurring_task_unhandled", error: error instanceof Error ? error.name : "unknown" }));
    }).finally(() => { active = null; });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  if (options.immediate !== false) run();
  return {
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
