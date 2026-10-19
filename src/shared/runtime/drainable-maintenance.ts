export type MaintenanceStop = () => Promise<void>;

/**
 * Prevents a new periodic cycle after drain begins and waits for the one
 * already claimed by this process. Callers keep their existing durable claim,
 * retry, and error handling semantics inside `cycle`.
 */
export function startDrainingInterval(
  cycle: () => Promise<void>,
  intervalMs: number,
  options: Readonly<{ immediate?: boolean }> = {}
): MaintenanceStop {
  let accepting = true;
  let running: Promise<void> | null = null;

  const run = (): void => {
    if (!accepting || running) return;
    const execution = Promise.resolve().then(cycle);
    const tracked = execution.finally(() => {
      if (running === tracked) running = null;
    });
    running = tracked;
    // The cycle owns its sanitized logging. Keep interval callbacks from
    // creating unhandled rejections while preserving a rejected drain result.
    void tracked.catch(() => undefined);
  };

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  if (options.immediate) run();

  return async (): Promise<void> => {
    accepting = false;
    clearInterval(timer);
    await running;
  };
}
