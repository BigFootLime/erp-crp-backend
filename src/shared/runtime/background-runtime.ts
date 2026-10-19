import type { Pool, PoolClient } from "pg";

import { logger } from "../observability/logger";

export type RuntimeRole = "api" | "worker" | "all";
type WorkerState = "disabled" | "waiting" | "leader" | "lost" | "stopped" | "not_started";
type Stop = () => void | Promise<void>;

type LeaderClient = Pick<PoolClient, "query" | "on"> & {
  release: (destroy?: boolean | Error) => void;
};
type LeaderPool = Pick<Pool, "connect">;

const LEADER_KEY = "cerp:background-worker:v1";
const DEFAULT_RETRY_MS = 5_000;

let current: { role: RuntimeRole; state: WorkerState; started: boolean } = {
  role: "all",
  state: "not_started",
  started: false,
};

function boundedPositiveInteger(raw: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export function resolveRuntimeRole(environment = process.env): RuntimeRole {
  const configured = (environment.CERP_RUNTIME_ROLE ?? "all").trim().toLowerCase();
  if (configured === "api" || configured === "worker" || configured === "all") return configured;
  throw Object.assign(new Error("CERP_RUNTIME_ROLE_INVALID"), { code: "CERP_RUNTIME_ROLE_INVALID" });
}

export type BackgroundRuntimeReadiness = Readonly<{
  role: RuntimeRole;
  worker_state: WorkerState;
  maintenance_enabled: boolean;
  leadership_required: boolean;
  ready: boolean;
}>;

export function getBackgroundRuntimeReadiness(): BackgroundRuntimeReadiness {
  const leadershipRequired = current.started && current.role !== "api";
  return {
    role: current.role,
    worker_state: current.state,
    maintenance_enabled: current.state === "leader",
    leadership_required: leadershipRequired,
    ready: !leadershipRequired || current.state === "leader",
  };
}

export type BackgroundRuntimeOptions = Readonly<{
  pool: LeaderPool;
  startMaintenance: () => readonly Stop[] | Promise<readonly Stop[]>;
  environment?: NodeJS.ProcessEnv;
  onLeadershipLost?: () => void;
}>;

export type BackgroundRuntime = Readonly<{
  role: RuntimeRole;
  stop: () => Promise<void>;
}>;

async function stopAll(stops: readonly Stop[]): Promise<void> {
  const results = await Promise.allSettled(stops.map((stop) => Promise.resolve().then(stop)));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

function defaultLeadershipLoss(): void {
  process.exitCode = 1;
  setImmediate(() => process.kill(process.pid, "SIGTERM"));
}

/**
 * Starts durable maintenance only while this process owns a PostgreSQL session
 * advisory lock. The lock is held by a dedicated pool client, never by a
 * transaction, so a connection loss cannot leave a worker executing blindly.
 */
export function startBackgroundRuntime(options: BackgroundRuntimeOptions): BackgroundRuntime {
  const environment = options.environment ?? process.env;
  const role = resolveRuntimeRole(environment);
  current = { role, state: role === "api" ? "disabled" : "waiting", started: true };

  if (role === "api") return { role, stop: async () => { current = { role, state: "stopped", started: true }; } };

  const retryMs = boundedPositiveInteger(environment.CERP_BACKGROUND_LEADER_RETRY_MS, DEFAULT_RETRY_MS, 1_000);
  let stopped = false;
  let attempting = false;
  let leaderClient: LeaderClient | null = null;
  let maintenance: readonly Stop[] = [];
  let retryTimer: NodeJS.Timeout | null = null;
  let activeAttempt: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const unlockAndRelease = async (client: LeaderClient): Promise<void> => {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [LEADER_KEY]);
      client.release();
    } catch {
      // Destroy a session if unlock cannot be confirmed so a session-level lock
      // is never handed back to the pool.
      client.release(true);
    }
  };

  const scheduleRetry = (): void => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      beginAttempt();
    }, retryMs);
  };

  const handleLeadershipLoss = (): void => {
    if (stopped || current.state !== "leader") return;
    current = { role, state: "lost", started: true };
    const priorMaintenance = maintenance;
    maintenance = [];
    const lostClient = leaderClient;
    leaderClient = null;
    try {
      lostClient?.release(true);
    } catch {
      // The broken PostgreSQL session will be discarded by the pool.
    }
    void stopAll(priorMaintenance).catch(() => undefined).finally(() => {
      logger.error("background_worker_leadership_lost", { runtime_role: role });
      (options.onLeadershipLost ?? defaultLeadershipLoss)();
    });
  };

  const attemptLeadership = async (): Promise<void> => {
    if (stopped || attempting || leaderClient) return;
    attempting = true;
    let client: LeaderClient | null = null;
    try {
      client = await options.pool.connect();
      if (stopped) {
        client.release();
        return;
      }
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [LEADER_KEY]
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        if (stopped) return;
        current = { role, state: "waiting", started: true };
        scheduleRetry();
        return;
      }
      if (stopped) {
        await unlockAndRelease(client);
        return;
      }
      const startedMaintenance = await options.startMaintenance();
      if (stopped) {
        try {
          await stopAll(startedMaintenance);
        } finally {
          await unlockAndRelease(client);
        }
        return;
      }
      maintenance = startedMaintenance;
      leaderClient = client;
      client.on("error", handleLeadershipLoss);
      current = { role, state: "leader", started: true };
      logger.info("background_worker_leadership_acquired", { runtime_role: role });
    } catch (error) {
      if (client && client !== leaderClient) client.release(true);
      if (!stopped) {
        current = { role, state: "waiting", started: true };
        logger.warn("background_worker_leadership_waiting", { runtime_role: role });
        scheduleRetry();
      }
    } finally {
      attempting = false;
    }
  };

  const beginAttempt = (): void => {
    if (stopped || activeAttempt) return;
    const attempt = attemptLeadership();
    activeAttempt = attempt;
    void attempt.finally(() => {
      if (activeAttempt === attempt) activeAttempt = null;
    }).catch(() => undefined);
  };

  beginAttempt();

  return {
    role,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        stopped = true;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        current = { role, state: "stopped", started: true };
        const pendingAttempt = activeAttempt;
        if (pendingAttempt) await pendingAttempt;
        const client = leaderClient;
        leaderClient = null;
        const priorMaintenance = maintenance;
        maintenance = [];
        let maintenanceFailure: unknown = null;
        try {
          await stopAll(priorMaintenance);
        } catch (error) {
          maintenanceFailure = error;
        } finally {
          if (client) await unlockAndRelease(client);
        }
        if (maintenanceFailure) throw maintenanceFailure;
      })();
      return stopPromise;
    },
  };
}

export function resetBackgroundRuntimeForTests(): void {
  current = { role: "all", state: "not_started", started: false };
}
