import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  createApplicationShutdown,
  type ShutdownHttpServer,
} from "../shared/runtime/application-shutdown";

function listeningServer(onClose?: () => void): ShutdownHttpServer {
  return {
    listening: true,
    close: (callback) => {
      onClose?.();
      callback();
    },
  };
}

describe("application shutdown", () => {
  it("closes maintenance, realtime, HTTP and PostgreSQL exactly once", async () => {
    const stopMaintenance = vi.fn();
    const stopRealtime = vi.fn(async () => undefined);
    const closeDatabase = vi.fn(async () => undefined);
    const closeHttp = vi.fn();
    const shutdown = createApplicationShutdown({
      httpServer: listeningServer(closeHttp),
      stopRealtime,
      stopMaintenance: [stopMaintenance],
      closeDatabase,
    }, 100);

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");

    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ exitCode: 0, timedOut: false });
    expect(stopMaintenance).toHaveBeenCalledTimes(1);
    expect(stopRealtime).toHaveBeenCalledTimes(1);
    expect(closeHttp).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it("still closes PostgreSQL and reports failure when a shutdown phase rejects", async () => {
    const closeDatabase = vi.fn(async () => undefined);
    const closeHttp = vi.fn();
    const log = vi.fn();
    const shutdown = createApplicationShutdown({
      httpServer: listeningServer(closeHttp),
      stopRealtime: vi.fn(async () => { throw new Error("private failure detail"); }),
      stopMaintenance: [],
      closeDatabase,
      log,
    }, 100);

    await expect(shutdown("SIGTERM")).resolves.toEqual({ exitCode: 1, timedOut: false });
    expect(closeHttp).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("application_shutdown_failed", {
      signal: "SIGTERM",
      error: "Error",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private failure detail");
  });

  it("does not close HTTP twice when Socket.IO already closed the underlying server", async () => {
    const close = vi.fn();
    const closeEvent = vi.fn();
    const events = new EventEmitter();
    events.once("close", closeEvent);
    const httpServer = Object.assign(events, {
      listening: true,
      close: (callback) => {
        close();
        callback();
      },
    }) as ShutdownHttpServer;
    const shutdown = createApplicationShutdown({
      httpServer,
      stopRealtime: vi.fn(async () => {
        httpServer.listening = false;
        events.emit("close");
      }),
      stopMaintenance: [],
      closeDatabase: vi.fn(async () => undefined),
    }, 100);

    await expect(shutdown("SIGTERM")).resolves.toEqual({ exitCode: 0, timedOut: false });
    expect(closeEvent).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("forces bounded termination and starts database closure when services hang", async () => {
    const closeAllConnections = vi.fn();
    const closeDatabase = vi.fn(async () => undefined);
    const never = new Promise<void>(() => undefined);
    const shutdown = createApplicationShutdown({
      httpServer: {
        listening: true,
        close: () => undefined,
        closeAllConnections,
      },
      stopRealtime: () => never,
      stopMaintenance: [],
      closeDatabase,
    }, 10);

    await expect(shutdown("SIGINT")).resolves.toEqual({ exitCode: 1, timedOut: true });
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });
});
