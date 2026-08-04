export type ShutdownHttpServer = {
  listening: boolean;
  close: (callback: (error?: Error) => void) => unknown;
  closeAllConnections?: () => void;
};

export type ApplicationShutdownDependencies = {
  httpServer: ShutdownHttpServer;
  stopRealtime: () => Promise<void>;
  stopMaintenance: readonly (() => void)[];
  closeDatabase: () => Promise<void>;
  log?: (type: string, fields: Record<string, string | number | boolean>) => void;
};

export type ApplicationShutdownResult = {
  exitCode: 0 | 1;
  timedOut: boolean;
};

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

export function createApplicationShutdown(
  dependencies: ApplicationShutdownDependencies,
  timeoutMs = 10_000
): (signal: string) => Promise<ApplicationShutdownResult> {
  const boundedTimeoutMs = Math.max(1, Math.trunc(timeoutMs));
  let shutdownPromise: Promise<ApplicationShutdownResult> | null = null;
  let realtimeStopPromise: Promise<void> | null = null;
  let httpClosePromise: Promise<void> | null = null;
  let databaseClosePromise: Promise<void> | null = null;
  let maintenanceStopped = false;

  const log = (type: string, fields: Record<string, string | number | boolean>): void => {
    dependencies.log?.(type, fields);
  };

  const stopMaintenanceOnce = (): unknown[] => {
    if (maintenanceStopped) return [];
    maintenanceStopped = true;
    const errors: unknown[] = [];
    for (const stop of dependencies.stopMaintenance) {
      try {
        stop();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };

  const stopRealtimeOnce = (): Promise<void> => {
    if (!realtimeStopPromise) {
      realtimeStopPromise = Promise.resolve().then(() => dependencies.stopRealtime());
    }
    return realtimeStopPromise;
  };

  const closeHttpOnce = (): Promise<void> => {
    if (httpClosePromise) return httpClosePromise;
    httpClosePromise = new Promise<void>((resolve, reject) => {
      if (!dependencies.httpServer.listening) {
        resolve();
        return;
      }
      try {
        dependencies.httpServer.close((error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
    return httpClosePromise;
  };

  const closeDatabaseOnce = (): Promise<void> => {
    if (!databaseClosePromise) {
      databaseClosePromise = Promise.resolve().then(() => dependencies.closeDatabase());
    }
    return databaseClosePromise;
  };

  const runGracefulShutdown = async (): Promise<void> => {
    const errors = stopMaintenanceOnce();
    try {
      await stopRealtimeOnce();
    } catch (error) {
      errors.push(error);
    }
    try {
      // Socket.IO may already have closed its underlying HTTP server.
      await closeHttpOnce();
    } catch (error) {
      errors.push(error);
    }
    try {
      await closeDatabaseOnce();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw Object.assign(new Error("APPLICATION_SHUTDOWN_PHASE_FAILED"), {
        cause: errors[0],
        failureCount: errors.length,
      });
    }
  };

  return (signal: string): Promise<ApplicationShutdownResult> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = new Promise<ApplicationShutdownResult>((resolve) => {
      let settled = false;
      const finish = (result: ApplicationShutdownResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      const timeout = setTimeout(() => {
        try {
          dependencies.httpServer.closeAllConnections?.();
        } catch {
          // The process exits with failure below; no payload from the error is logged.
        }
        stopMaintenanceOnce();
        void closeDatabaseOnce().catch(() => undefined);
        log("application_shutdown_timeout", { signal, timeoutMs: boundedTimeoutMs });
        finish({ exitCode: 1, timedOut: true });
      }, boundedTimeoutMs);

      void runGracefulShutdown().then(
        () => finish({ exitCode: 0, timedOut: false }),
        (error: unknown) => {
          log("application_shutdown_failed", {
            signal,
            error: safeErrorName(error),
          });
          finish({ exitCode: 1, timedOut: false });
        }
      );
    });

    return shutdownPromise;
  };
}
