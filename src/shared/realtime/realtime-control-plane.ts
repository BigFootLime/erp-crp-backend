import crypto from "node:crypto";
import { Client } from "pg";

import pool from "../../config/database";
import type { RealtimeSubscription } from "./realtime-room-policy";

const CONTROL_CHANNEL = "cerp_realtime_control";
const DEFAULT_RETENTION_HOURS = 24;
const MAX_READ_BATCH = 500;
const MAX_PUBLISH_ATTEMPTS = 3;

export type RealtimeControlSignal =
  | { kind: "event" }
  | { kind: "session_revoked"; userId: number };

export type RealtimeEventRecord = {
  sequence: bigint;
  eventId: string;
  streamId: string;
  event: string;
  payload: unknown;
  targets: RealtimeSubscription[];
  occurredAt: string;
};

export type PublishRealtimeEventInput = {
  event: string;
  payload: unknown;
  targets: readonly RealtimeSubscription[];
  streamId: string;
  deduplicationKey?: string;
};

export interface RealtimeControlPlane {
  latestSequence(): Promise<bigint>;
  publish(input: PublishRealtimeEventInput): Promise<RealtimeEventRecord>;
  readAfter(sequence: bigint, limit?: number): Promise<RealtimeEventRecord[]>;
  revokeSessions(userId: number): Promise<number>;
  subscribe(listener: (signal: RealtimeControlSignal) => void): Promise<() => Promise<void>>;
  pruneExpired(): Promise<number>;
}

export type RealtimeControlPlaneMetrics = {
  publishRetries: number;
  publishFailures: number;
  listenerErrors: number;
  invalidStoredEvents: number;
};

const controlPlaneMetrics: RealtimeControlPlaneMetrics = {
  publishRetries: 0,
  publishFailures: 0,
  listenerErrors: 0,
  invalidStoredEvents: 0,
};

type StoredEventRow = {
  sequence: string;
  event_id: string;
  stream_id: string;
  event_name: string;
  payload: unknown;
  targets: unknown;
  occurred_at: Date | string;
};

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredTarget(value: unknown): value is RealtimeSubscription {
  if (!isRecord(value) || typeof value.scope !== "string") return false;
  if (value.scope === "module") return typeof value.moduleKey === "string";
  if (value.scope === "entity") return typeof value.entityType === "string" && typeof value.entityId === "string";
  if (value.scope === "station") {
    return (value.kind === "STATION" || value.kind === "MACHINE" || value.kind === "OF") && typeof value.id === "string";
  }
  if (value.scope === "user") return Number.isSafeInteger(value.userId) && Number(value.userId) > 0;
  if (value.scope === "capability") return typeof value.capability === "string";
  return false;
}

function parseStoredEvent(row: StoredEventRow): RealtimeEventRecord | null {
  const targets = Array.isArray(row.targets) && row.targets.every(isStoredTarget) ? row.targets : null;
  let sequence: bigint;
  try {
    sequence = BigInt(row.sequence);
  } catch {
    return null;
  }
  if (
    sequence <= 0n
    || typeof row.event_id !== "string"
    || typeof row.stream_id !== "string"
    || typeof row.event_name !== "string"
    || !targets
  ) return null;
  return {
    sequence,
    eventId: row.event_id,
    streamId: row.stream_id,
    event: row.event_name,
    payload: row.payload,
    targets,
    occurredAt: new Date(row.occurred_at).toISOString(),
  };
}

function isRetryablePublishError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = typeof error.code === "string" ? error.code : "";
  return code.startsWith("08")
    || code === "40001"
    || code === "40P01"
    || code === "55P03"
    || code === "57P01"
    || code === "ECONNRESET"
    || code === "ETIMEDOUT";
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, attempt * 25));
}

function privacySafeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

async function publishOnce(
  input: PublishRealtimeEventInput,
  eventId: string,
  deduplicationKey: string
): Promise<RealtimeEventRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const retentionHours = positiveIntEnv("REALTIME_EVENT_RETENTION_HOURS", DEFAULT_RETENTION_HOURS);
    const { rows } = await client.query<StoredEventRow>(
      `
        INSERT INTO public.realtime_event_log
          (event_id, deduplication_key, stream_id, event_name, payload, targets, expires_at)
        VALUES
          ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, now() + ($7::text || ' hours')::interval)
        ON CONFLICT (deduplication_key) DO UPDATE
          SET deduplication_key = EXCLUDED.deduplication_key
        RETURNING
          sequence::text,
          event_id::text,
          stream_id,
          event_name,
          payload,
          targets,
          occurred_at
      `,
      [
        eventId,
        deduplicationKey,
        input.streamId,
        input.event,
        JSON.stringify(input.payload ?? null),
        JSON.stringify(input.targets),
        retentionHours,
      ]
    );
    await client.query("SELECT pg_notify($1, $2)", [CONTROL_CHANNEL, JSON.stringify({ kind: "event" })]);
    await client.query("COMMIT");
    const parsed = rows[0] ? parseStoredEvent(rows[0]) : null;
    if (!parsed) throw new Error("INVALID_REALTIME_EVENT_ROW");
    return parsed;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresRealtimeControlPlane implements RealtimeControlPlane {
  async latestSequence(): Promise<bigint> {
    const { rows } = await pool.query<{ sequence: string }>(
      "SELECT COALESCE(MAX(sequence), 0)::text AS sequence FROM public.realtime_event_log"
    );
    return BigInt(rows[0]?.sequence ?? "0");
  }

  async publish(input: PublishRealtimeEventInput): Promise<RealtimeEventRecord> {
    const eventId = crypto.randomUUID();
    const deduplicationKey = input.deduplicationKey?.trim() || eventId;
    let lastError: unknown;
    let attempts = 0;
    for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      try {
        return await publishOnce(input, eventId, deduplicationKey);
      } catch (error) {
        lastError = error;
        if (attempt === MAX_PUBLISH_ATTEMPTS || !isRetryablePublishError(error)) break;
        controlPlaneMetrics.publishRetries += 1;
        console.warn(JSON.stringify({
          type: "realtime_publish_retry",
          event: input.event,
          attempt,
          error: privacySafeErrorName(error),
        }));
        await retryDelay(attempt);
      }
    }
    controlPlaneMetrics.publishFailures += 1;
    console.error(JSON.stringify({
      type: "realtime_publish_failed",
      event: input.event,
      attempts,
      error: privacySafeErrorName(lastError),
    }));
    throw lastError;
  }

  async readAfter(sequence: bigint, limit = MAX_READ_BATCH): Promise<RealtimeEventRecord[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), MAX_READ_BATCH));
    const { rows } = await pool.query<StoredEventRow>(
      `
        SELECT
          sequence::text,
          event_id::text,
          stream_id,
          event_name,
          payload,
          targets,
          occurred_at
        FROM public.realtime_event_log
        WHERE sequence > $1::bigint
          AND expires_at > now()
        ORDER BY sequence ASC
        LIMIT $2
      `,
      [sequence.toString(), boundedLimit]
    );
    const parsed: RealtimeEventRecord[] = [];
    for (const row of rows) {
      const event = parseStoredEvent(row);
      if (event) parsed.push(event);
      else controlPlaneMetrics.invalidStoredEvents += 1;
    }
    return parsed;
  }

  async revokeSessions(userId: number): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ session_epoch: string }>(
        `
          INSERT INTO public.realtime_session_epochs (user_id, session_epoch, updated_at)
          VALUES ($1, 1, clock_timestamp())
          ON CONFLICT (user_id) DO UPDATE
            SET session_epoch = public.realtime_session_epochs.session_epoch + 1,
                updated_at = clock_timestamp()
          RETURNING session_epoch::text
        `,
        [userId]
      );
      await client.query("SELECT pg_notify($1, $2)", [
        CONTROL_CHANNEL,
        JSON.stringify({ kind: "session_revoked", userId }),
      ]);
      await client.query("COMMIT");
      return Number.parseInt(rows[0]?.session_epoch ?? "0", 10);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async subscribe(listener: (signal: RealtimeControlSignal) => void): Promise<() => Promise<void>> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL_MISSING");
    const client = new Client({ connectionString });
    client.on("error", (error) => {
      controlPlaneMetrics.listenerErrors += 1;
      console.error(JSON.stringify({
        type: "realtime_control_listener_error",
        error: privacySafeErrorName(error),
      }));
    });
    client.on("notification", (message) => {
      if (message.channel !== CONTROL_CHANNEL || typeof message.payload !== "string") return;
      try {
        const parsed = JSON.parse(message.payload) as unknown;
        if (!isRecord(parsed) || typeof parsed.kind !== "string") return;
        if (parsed.kind === "event") listener({ kind: "event" });
        if (parsed.kind === "session_revoked" && Number.isSafeInteger(parsed.userId) && Number(parsed.userId) > 0) {
          listener({ kind: "session_revoked", userId: Number(parsed.userId) });
        }
      } catch {
        controlPlaneMetrics.listenerErrors += 1;
      }
    });
    await client.connect();
    await client.query(`LISTEN ${CONTROL_CHANNEL}`);
    return async () => {
      await client.query(`UNLISTEN ${CONTROL_CHANNEL}`).catch(() => undefined);
      await client.end().catch(() => undefined);
    };
  }

  async pruneExpired(): Promise<number> {
    const { rowCount } = await pool.query(
      `
        WITH expired AS (
          SELECT sequence
          FROM public.realtime_event_log
          WHERE expires_at <= now()
          ORDER BY sequence
          LIMIT 1000
        )
        DELETE FROM public.realtime_event_log event
        USING expired
        WHERE event.sequence = expired.sequence
      `
    );
    return rowCount ?? 0;
  }
}

export async function repoRealtimeSessionEpoch(userId: number): Promise<number> {
  const { rows } = await pool.query<{ session_epoch: string }>(
    "SELECT session_epoch::text FROM public.realtime_session_epochs WHERE user_id = $1",
    [userId]
  );
  return Number.parseInt(rows[0]?.session_epoch ?? "0", 10);
}

export function getRealtimeControlPlaneMetrics(): Readonly<RealtimeControlPlaneMetrics> {
  return { ...controlPlaneMetrics };
}

export function resetRealtimeControlPlaneMetrics(): void {
  for (const key of Object.keys(controlPlaneMetrics) as Array<keyof RealtimeControlPlaneMetrics>) {
    controlPlaneMetrics[key] = 0;
  }
}
