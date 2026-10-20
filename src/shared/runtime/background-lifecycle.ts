import type { Pool, PoolClient } from "pg";
import { errorFingerprint, logger, safeErrorCode } from "../observability/logger";

export type BackgroundWorkerMode = "always" | "leader" | "off";
export type Stop = () => void | Promise<void>;
export type BackgroundStarter = () => Stop;

const LOCK_KEY = 7_251_901_601;

function boolean(value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === "") return undefined;
  if (["1", "true", "yes", "on"].includes(value.trim().toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.trim().toLowerCase())) return false;
  throw new Error("CERP_STANDBY must be a boolean");
}

export function backgroundWorkerMode(env: NodeJS.ProcessEnv = process.env): BackgroundWorkerMode {
  const standby = boolean(env.CERP_STANDBY);
  const configured = (env.CERP_BACKGROUND_WORKERS ?? "always").trim().toLowerCase();
  if (!["always", "leader", "off"].includes(configured)) {
    throw new Error("CERP_BACKGROUND_WORKERS must be always, leader or off");
  }
  if (standby === true && configured !== "always" && configured !== "off") {
    throw new Error("CERP_STANDBY cannot be combined with CERP_BACKGROUND_WORKERS=leader");
  }
  return standby === true ? "off" : configured as BackgroundWorkerMode;
}

export type BackgroundLifecycle = { stop: () => Promise<void>; mode: BackgroundWorkerMode };

type Dependencies = {
  pool: Pick<Pool, "connect">;
  starters: BackgroundStarter[];
  env?: NodeJS.ProcessEnv;
  retryMs?: number;
  setInterval?: typeof global.setInterval;
  clearInterval?: typeof global.clearInterval;
};

/**
 * Starts recurring application work once per database when explicitly enabled
 * in leader mode. PostgreSQL advisory locks live on the dedicated client, so a
 * stopped or crashed leader releases ownership automatically. Legacy installs
 * keep `always` as their default until their release configuration opts in.
 */
export function startBackgroundLifecycle(input: Dependencies): BackgroundLifecycle {
  const mode = backgroundWorkerMode(input.env);
  let stopped = false;
  let leaderClient: PoolClient | undefined;
  let removeLeaderListeners: (() => void) | undefined;
  let stopWorkers: Stop[] = [];
  let acquiring = false;
  const retryMs = input.retryMs ?? 5_000;
  const setTimer = input.setInterval ?? global.setInterval;
  const clearTimer = input.clearInterval ?? global.clearInterval;

  const stopStarted = async (): Promise<void> => {
    for (const stop of stopWorkers.splice(0).reverse()) {
      try { await stop(); } catch (error) { logger.error("background_worker_stop_failed", { error_code: safeErrorCode(error), error_fingerprint: errorFingerprint(error) }); }
    }
  };

  const loseLeadership = async (client: PoolClient, event: "error" | "end"): Promise<void> => {
    if (leaderClient !== client) return;
    // Block a retry until every asynchronous worker has stopped and the
    // advisory-lock connection is released. A second colour must never start
    // work while this process still owns an in-flight stop callback.
    acquiring = true;
    leaderClient = undefined;
    removeLeaderListeners?.();
    removeLeaderListeners = undefined;
    await stopStarted();
    try { client.release(true); } catch { /* the disconnected connection is already unusable */ }
    finally { acquiring = false; }
    logger.error("background_worker_leader_connection_lost", { lock_key: LOCK_KEY, event });
  };

  const becomeLeader = async (): Promise<void> => {
    if (stopped || leaderClient || acquiring) return;
    acquiring = true;
    let client: PoolClient | undefined;
    try {
      client = await input.pool.connect();
      const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [LOCK_KEY]);
      if (!result.rows[0]?.acquired) {
        client.release();
        return;
      }
      if (stopped) {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]);
        client.release();
        return;
      }
      leaderClient = client;
      const onError = (): void => { void loseLeadership(client!, "error"); };
      const onEnd = (): void => { void loseLeadership(client!, "end"); };
      client.once("error", onError);
      client.once("end", onEnd);
      removeLeaderListeners = () => {
        client?.removeListener("error", onError);
        client?.removeListener("end", onEnd);
      };
      for (const starter of input.starters) stopWorkers.push(starter());
      logger.info("background_worker_leader_acquired", { lock_key: LOCK_KEY, worker_count: stopWorkers.length });
    } catch (error) {
      await stopStarted();
      if (leaderClient) {
        const acquired = leaderClient;
        leaderClient = undefined;
        removeLeaderListeners?.();
        removeLeaderListeners = undefined;
        try { await acquired.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]); }
        finally { acquired.release(); }
      } else if (client) {
        client.release();
      }
      logger.error("background_worker_leader_acquire_failed", { error_code: safeErrorCode(error), error_fingerprint: errorFingerprint(error) });
    } finally {
      acquiring = false;
    }
  };

  if (mode === "always") {
    stopWorkers = input.starters.map((starter) => starter());
    logger.info("background_workers_started", { mode, worker_count: stopWorkers.length });
  } else if (mode === "leader") {
    void becomeLeader();
  } else {
    logger.info("background_workers_standby", { mode });
  }

  const timer = mode === "leader" ? setTimer(() => void becomeLeader(), retryMs) : undefined;
  return {
    mode,
    stop: async () => {
      stopped = true;
      if (timer) clearTimer(timer);
      await stopStarted();
      if (leaderClient) {
        const client = leaderClient;
        leaderClient = undefined;
        removeLeaderListeners?.();
        removeLeaderListeners = undefined;
        try { await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]); }
        finally { client.release(); }
        logger.info("background_worker_leader_released", { lock_key: LOCK_KEY });
      }
    },
  };
}
