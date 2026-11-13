import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { backgroundWorkerMode, startBackgroundLifecycle } from "./background-lifecycle";
import { getBackgroundRuntimeSnapshot } from "./background-runtime-state";

const client = (acquired: boolean) => Object.assign(new EventEmitter(), {
  query: vi.fn().mockResolvedValue({ rows: [{ acquired }] }),
  release: vi.fn(),
});

describe("background worker lifecycle", () => {
  it("keeps the legacy behaviour unless explicitly configured", () => {
    expect(backgroundWorkerMode({})).toBe("always");
    expect(backgroundWorkerMode({ CERP_STANDBY: "true" })).toBe("off");
    expect(backgroundWorkerMode({ CERP_BACKGROUND_WORKERS: "leader" })).toBe("leader");
    expect(() => backgroundWorkerMode({ CERP_STANDBY: "true", CERP_BACKGROUND_WORKERS: "leader" })).toThrow(/cannot be combined/);
  });

  it("rejects an invalid worker mode before work starts", () => {
    expect(() => backgroundWorkerMode({ CERP_BACKGROUND_WORKERS: "parallel" })).toThrow(/always, leader or off/);
    expect(() => backgroundWorkerMode({ CERP_STANDBY: "maybe" })).toThrow(/boolean/);
  });

  it("does not start work while in standby", async () => {
    const start = vi.fn(() => vi.fn());
    const lifecycle = startBackgroundLifecycle({ pool: { connect: vi.fn() } as never, starters: [start], env: { CERP_STANDBY: "true" } });
    expect(lifecycle.mode).toBe("off");
    expect(start).not.toHaveBeenCalled();
    expect(getBackgroundRuntimeSnapshot()).toMatchObject({ mode: "off", workers_running: 0, drain_guarantee: "callbacks_awaited_not_task_fenced" });
    await lifecycle.stop();
  });

  it("allows exactly one leader and releases it on shutdown", async () => {
    const leader = client(true);
    const start = vi.fn(() => vi.fn());
    const lifecycle = startBackgroundLifecycle({
      pool: { connect: vi.fn().mockResolvedValue(leader) } as never,
      starters: [start], env: { CERP_BACKGROUND_WORKERS: "leader" }, retryMs: 60_000,
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await lifecycle.stop();
    expect(leader.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1::bigint)", [7_251_901_601]);
    expect(leader.release).toHaveBeenCalledTimes(1);
  });

  it("keeps a losing colour idle while the database lock belongs to another process", async () => {
    const candidate = client(false);
    const start = vi.fn(() => vi.fn());
    const lifecycle = startBackgroundLifecycle({
      pool: { connect: vi.fn().mockResolvedValue(candidate) } as never,
      starters: [start], env: { CERP_BACKGROUND_WORKERS: "leader" }, retryMs: 60_000,
    });
    await vi.waitFor(() => expect(candidate.release).toHaveBeenCalledTimes(1));
    expect(start).not.toHaveBeenCalled();
    expect(getBackgroundRuntimeSnapshot()).toMatchObject({ mode: "leader", leader_state: "waiting", workers_running: 0 });
    await lifecycle.stop();
  });

  it("stops active work before releasing a lost leader connection", async () => {
    const leader = client(true);
    const stopped = vi.fn();
    const started = vi.fn(() => stopped);
    const lifecycle = startBackgroundLifecycle({
      pool: { connect: vi.fn().mockResolvedValue(leader) } as never,
      starters: [started], env: { CERP_BACKGROUND_WORKERS: "leader" }, retryMs: 60_000,
    });
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    leader.emit("error", new Error("connection lost"));
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(leader.release).toHaveBeenCalledWith(true));
    await lifecycle.stop();
  });

  it("does not retry leadership while an asynchronous worker is still stopping", async () => {
    const leader = client(true);
    const replacement = client(true);
    const connect = vi.fn().mockResolvedValueOnce(leader).mockResolvedValueOnce(replacement);
    let retry: (() => void) | undefined;
    let finishStop: (() => void) | undefined;
    const started = vi.fn(() => () => new Promise<void>((resolve) => { finishStop = resolve; }));
    const lifecycle = startBackgroundLifecycle({
      pool: { connect } as never,
      starters: [started],
      env: { CERP_BACKGROUND_WORKERS: "leader" }, retryMs: 60_000,
      setInterval: ((callback: () => void) => { retry = callback; return {} as NodeJS.Timeout; }) as typeof setInterval,
      clearInterval: () => undefined,
    });
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    leader.emit("error", new Error("connection lost"));
    retry?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connect).toHaveBeenCalledTimes(1);
    finishStop?.();
    await vi.waitFor(() => expect(leader.release).toHaveBeenCalledWith(true));
    retry?.();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    await lifecycle.stop();
  });

  it("signals every worker to stop before waiting for a long drain", async () => {
    const first = client(true);
    let releaseFirst: (() => void) | undefined;
    const firstStop = vi.fn(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    const secondStop = vi.fn();
    const firstStarter = vi.fn(() => firstStop);
    const secondStarter = vi.fn(() => secondStop);
    const lifecycle = startBackgroundLifecycle({
      pool: { connect: vi.fn().mockResolvedValue(first) } as never,
      starters: [firstStarter, secondStarter],
      env: { CERP_BACKGROUND_WORKERS: "leader" },
      retryMs: 60_000,
    });
    await vi.waitFor(() => expect(firstStarter).toHaveBeenCalledTimes(1));
    expect(secondStarter).toHaveBeenCalledTimes(1);
    const stopping = lifecycle.stop();
    await vi.waitFor(() => expect(firstStop).toHaveBeenCalledTimes(1));
    expect(secondStop).toHaveBeenCalledTimes(1);
    let settled = false;
    void stopping.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    releaseFirst?.();
    await stopping;
    expect(first.release).toHaveBeenCalledTimes(1);
  });

  it("joins an in-progress lost-leader drain before reporting shutdown complete", async () => {
    const leader = client(true);
    let releaseCycle: (() => void) | undefined;
    const stopWorker = vi.fn(() => new Promise<void>((resolve) => { releaseCycle = resolve; }));
    const starter = vi.fn(() => stopWorker);
    const lifecycle = startBackgroundLifecycle({
      pool: { connect: vi.fn().mockResolvedValue(leader) } as never,
      starters: [starter], env: { CERP_BACKGROUND_WORKERS: "leader" }, retryMs: 60_000,
    });
    await vi.waitFor(() => expect(starter).toHaveBeenCalledTimes(1));
    leader.emit("error", new Error("lost while draining"));
    await vi.waitFor(() => expect(stopWorker).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = lifecycle.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    releaseCycle?.();
    await stopping;
    expect(leader.release).toHaveBeenCalledWith(true);
  });

  it("does not reacquire or report drained after a worker stop failure", async () => {
    const leader = client(true);
    const replacement = client(true);
    const connect = vi.fn().mockResolvedValueOnce(leader).mockResolvedValueOnce(replacement);
    let retry: (() => void) | undefined;
    const stopWorker = vi.fn(() => { throw new Error("worker refuses to stop"); });
    const starter = vi.fn(() => stopWorker);
    const lifecycle = startBackgroundLifecycle({
      pool: { connect } as never,
      starters: [starter],
      env: { CERP_BACKGROUND_WORKERS: "leader" },
      retryMs: 60_000,
      setInterval: ((callback: () => void) => { retry = callback; return {} as NodeJS.Timeout; }) as typeof setInterval,
      clearInterval: () => undefined,
    });
    await vi.waitFor(() => expect(starter).toHaveBeenCalledTimes(1));
    leader.emit("error", new Error("lost"));
    await vi.waitFor(() => expect(stopWorker).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(leader.release).toHaveBeenCalledWith(true));
    expect(getBackgroundRuntimeSnapshot()).toMatchObject({ leader_state: "draining" });
    retry?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(lifecycle.stop()).rejects.toThrow("worker refuses to stop");
    expect(getBackgroundRuntimeSnapshot()).toMatchObject({ leader_state: "draining" });
  });

  it("retains a live advisory lock after a normal drain failure so green stays idle", async () => {
    let locked = false;
    const leasedClient = () => Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          if (locked) return { rows: [{ acquired: false }] };
          locked = true;
          return { rows: [{ acquired: true }] };
        }
        if (sql.includes("pg_advisory_unlock")) locked = false;
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const redClient = leasedClient();
    const greenClient = leasedClient();
    const redStop = vi.fn(() => { throw new Error("red worker cannot stop"); });
    const redStarter = vi.fn(() => redStop);
    const red = startBackgroundLifecycle({
      pool: { connect: vi.fn().mockResolvedValue(redClient) } as never,
      starters: [redStarter], env: { CERP_BACKGROUND_WORKERS: "leader" }, retryMs: 60_000,
    });
    await vi.waitFor(() => expect(redStarter).toHaveBeenCalledTimes(1));
    const greenStarter = vi.fn(() => vi.fn());
    const green = startBackgroundLifecycle({
      pool: { connect: vi.fn().mockResolvedValue(greenClient) } as never,
      starters: [greenStarter], env: { CERP_BACKGROUND_WORKERS: "leader" }, retryMs: 60_000,
    });
    await vi.waitFor(() => expect(greenClient.release).toHaveBeenCalledTimes(1));
    await expect(red.stop()).rejects.toThrow("red worker cannot stop");
    expect(redClient.query).not.toHaveBeenCalledWith("SELECT pg_advisory_unlock($1::bigint)", [7_251_901_601]);
    expect(redClient.release).not.toHaveBeenCalled();
    expect(locked).toBe(true);
    expect(greenStarter).not.toHaveBeenCalled();
    await green.stop();
  });
});
