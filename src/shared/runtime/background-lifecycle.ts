import type { Pool, PoolClient } from "pg";

import { errorFingerprint, logger, safeErrorCode } from "../observability/logger";
import { setBackgroundRuntimeSnapshot } from "./background-runtime-state";

export type BackgroundWorkerMode = "always" | "leader" | "off";
export type Stop = () => void | Promise<void>;
export type BackgroundStarter = () => Stop;

const LOCK_KEY = 7_251_901_601;

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === "") return undefined;
  if (["1", "true", "yes", "on"].includes(value.trim().toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.trim().toLowerCase())) return false;
  throw new Error("CERP_STANDBY must be a boolean");
}

export function backgroundWorkerMode(env: NodeJS.ProcessEnv = process.env): BackgroundWorkerMode {
  const standby = parseBoolean(env.CERP_STANDBY);
  const configured = (env.CERP_BACKGROUND_WORKERS ?? "always").trim().toLowerCase();
  if (!(["always", "leader", "off"] as const).includes(configured as BackgroundWorkerMode)) {
    throw new Error("CERP_BACKGROUND_WORKERS must be always, leader or off");
  }
  if (standby === true && configured === "leader") {
    throw new Error("CERP_STANDBY cannot be combined with CERP_BACKGROUND_WORKERS=leader");
  }
  return standby === true ? "off" : configured as BackgroundWorkerMode;
}

export type BackgroundLifecycle = {
  stop: () => Promise<void>;
  mode: BackgroundWorkerMode;
};

type Dependencies = {
  pool: Pick<Pool, "connect">;
  starters: BackgroundStarter[];
  env?: NodeJS.ProcessEnv;
  retryMs?: number;
  setInterval?: typeof global.setInterval;
  clearInterval?: typeof global.clearInterval;
};

/**
 * Owns periodic maintenance for one process. Leader mode uses a dedicated
 * session advisory lock; a lost session releases its PostgreSQL lock before
 * another colour can acquire it. Stop callbacks prevent future cycles and are
 * awaited for active cycles. They do not fence business effects or prove
 * exactly-once delivery under a partition; callers still need idempotence and
 * fencing before making that claim.
 */
export function startBackgroundLifecycle(input: Dependencies): BackgroundLifecycle {
  const mode = backgroundWorkerMode(input.env);
  const retryMs = input.retryMs ?? 5_000;
  const setTimer = input.setInterval ?? global.setInterval;
  const clearTimer = input.clearInterval ?? global.clearInterval;
  let stopped = false;
  let acquiring = false;
  let leaderClient: PoolClient | undefined;
  let removeLeaderListeners: (() => void) | undefined;
  let stopWorkers: Stop[] = [];
  let stopPromise: Promise<void> | undefined;
  let drainPromise: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;
  let drainFailure: unknown;
  let drainFailed = false;

  const publish = (leaderState: "not_started" | "leader" | "waiting" | "draining" | "drained"): void => {
    setBackgroundRuntimeSnapshot({
      mode,
      leader_state: leaderState,
      workers_running: stopWorkers.length,
      drain_guarantee: "callbacks_awaited_not_task_fenced",
    });
  };

  const stopStarted = (): Promise<void> => {
    if (drainPromise) return drainPromise;
    if (drainFailure) return Promise.reject(drainFailure);
    drainPromise = (async () => {
      const callbacks = stopWorkers.splice(0).reverse();
      publish("draining");
      const failures: unknown[] = [];
      // Invoke every stop synchronously before awaiting any of them.  Waiting
      // for a long-running first worker would otherwise leave other timers live.
      const stopping = callbacks.map((stop) => {
        try {
          return Promise.resolve(stop()).catch((error: unknown) => {
            failures.push(error);
            logger.error("background_worker_stop_failed", {
              error_code: safeErrorCode(error),
              error_fingerprint: errorFingerprint(error),
            });
          });
        } catch (error) {
          failures.push(error);
          logger.error("background_worker_stop_failed", {
            error_code: safeErrorCode(error),
            error_fingerprint: errorFingerprint(error),
          });
          return Promise.resolve();
        }
      });
      await Promise.all(stopping);
      if (failures.length > 0) {
        drainFailure = failures[0];
        drainFailed = true;
        // Keep the runtime visibly draining: a callback that could not stop
        // leaves its future-cycle guarantee unproven.
        throw drainFailure;
      }
      publish(stopped ? "drained" : "waiting");
    })();
    return drainPromise;
  };

  const releaseLeader = (client: PoolClient, destroy = false): Promise<void> => {
    if (leaderClient !== client) return releasePromise ?? Promise.resolve();
    leaderClient = undefined;
    removeLeaderListeners?.();
    removeLeaderListeners = undefined;
    releasePromise = (async () => {
      let stopError: unknown;
      try {
        await stopStarted();
      } catch (error) {
        stopError = error;
      }
      // With a live PostgreSQL session, a failed worker stop means its timer or
      // in-flight business effect may still exist. Retain the advisory lock and
      // checked-out session until process fencing/shutdown instead of letting a
      // second colour become leader beside uncertain work. A lost connection
      // cannot retain its server-side lock; this remains an explicit partition
      // limitation rather than an exactly-once guarantee.
      if (stopError && !destroy) throw stopError;
      try {
        if (!destroy) await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]);
      } finally {
        client.release(destroy);
      }
      if (stopError) throw stopError;
    })();
    return releasePromise;
  };

  const loseLeadership = async (client: PoolClient, event: "error" | "end"): Promise<void> => {
    if (leaderClient !== client || stopped) return;
    acquiring = true;
    try {
      await releaseLeader(client, true);
      publish("waiting");
      logger.error("background_worker_leader_connection_lost", { lock_key: LOCK_KEY, event });
    } catch (error) {
      logger.error("background_worker_drain_failed", {
        error_code: safeErrorCode(error),
        error_fingerprint: errorFingerprint(error),
      });
    } finally {
      acquiring = false;
    }
  };

  const becomeLeader = async (): Promise<void> => {
    if (stopped || drainFailed || leaderClient || acquiring) return;
    acquiring = true;
    let client: PoolClient | undefined;
    try {
      client = await input.pool.connect();
      const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [LOCK_KEY]);
      if (!result.rows[0]?.acquired) {
        client.release();
        publish("waiting");
        return;
      }
      if (stopped) {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]);
        client.release();
        return;
      }
      leaderClient = client;
      releasePromise = undefined;
      const onError = (): void => { void loseLeadership(client!, "error"); };
      const onEnd = (): void => { void loseLeadership(client!, "end"); };
      client.once("error", onError);
      client.once("end", onEnd);
      removeLeaderListeners = () => {
        client?.removeListener("error", onError);
        client?.removeListener("end", onEnd);
      };
      drainPromise = undefined;
      drainFailure = undefined;
      for (const starter of input.starters) stopWorkers.push(starter());
      publish("leader");
      logger.info("background_worker_leader_acquired", { lock_key: LOCK_KEY, worker_count: stopWorkers.length });
    } catch (error) {
      try {
        await stopStarted();
      } catch (stopError) {
        logger.error("background_worker_drain_failed", {
          error_code: safeErrorCode(stopError),
          error_fingerprint: errorFingerprint(stopError),
        });
      }
      if (leaderClient) await releaseLeader(leaderClient);
      else if (client) client.release();
      publish("waiting");
      logger.error("background_worker_leader_acquire_failed", {
        error_code: safeErrorCode(error),
        error_fingerprint: errorFingerprint(error),
      });
    } finally {
      acquiring = false;
    }
  };

  if (mode === "always") {
    stopWorkers = input.starters.map((starter) => starter());
    publish("leader");
    logger.info("background_workers_started", { mode, worker_count: stopWorkers.length });
  } else if (mode === "leader") {
    publish("waiting");
    void becomeLeader();
  } else {
    publish("waiting");
    logger.info("background_workers_standby", { mode });
  }

  const timer = mode === "leader" ? setTimer(() => void becomeLeader(), retryMs) : undefined;
  return {
    mode,
    stop: () => {
      if (!stopPromise) {
        stopPromise = (async () => {
          stopped = true;
          if (timer) clearTimer(timer);
          if (leaderClient) await releaseLeader(leaderClient);
          else if (releasePromise) await releasePromise;
          else await stopStarted();
          publish("drained");
        })();
      }
      return stopPromise;
    },
  };
}
