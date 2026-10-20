import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { backgroundWorkerMode, startBackgroundLifecycle } from "./background-lifecycle";

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

  it("does not start work while in standby", async () => {
    const start = vi.fn(() => vi.fn());
    const lifecycle = startBackgroundLifecycle({ pool: { connect: vi.fn() } as never, starters: [start], env: { CERP_STANDBY: "true" } });
    expect(lifecycle.mode).toBe("off");
    expect(start).not.toHaveBeenCalled();
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
});
