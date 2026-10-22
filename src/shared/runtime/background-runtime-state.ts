export type BackgroundRuntimeSnapshot = Readonly<{
  mode: "always" | "leader" | "off";
  leader_state: "not_started" | "leader" | "waiting" | "draining" | "drained";
  workers_running: number;
  drain_guarantee: "callbacks_awaited_not_task_fenced";
}>;

let snapshot: BackgroundRuntimeSnapshot = Object.freeze({
  mode: "always",
  leader_state: "not_started",
  workers_running: 0,
  drain_guarantee: "callbacks_awaited_not_task_fenced",
});

export function setBackgroundRuntimeSnapshot(next: BackgroundRuntimeSnapshot): void {
  snapshot = Object.freeze({ ...next });
}

export function getBackgroundRuntimeSnapshot(): BackgroundRuntimeSnapshot {
  return snapshot;
}
