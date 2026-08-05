import pool from "../../../config/database";

import type { OfflineStationEventDTO } from "../validators/offline-station.validators";

export type OfflineStoredOutcome = {
  event_id: string;
  status: "PROCESSING" | "SYNCED" | "REJECTED";
  result_payload: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  server_entity_id: string | null;
};

export type OfflineReservation =
  | { kind: "CONFLICT" }
  | { kind: "BUSY" }
  | { kind: "RESERVED"; existing: boolean; outcome: OfflineStoredOutcome };

export async function repoOfflineSyncEnabled(): Promise<boolean> {
  const { rows } = await pool.query<{ enabled: boolean }>(
    `SELECT enabled FROM public.production_station_offline_config WHERE singleton = true`
  );
  return rows[0]?.enabled === true;
}

/**
 * Reserve before applying the canonical command. A crash after reservation is
 * recoverable: the canonical execution idempotency key is replayed on retry.
 */
export async function repoReserveOfflineEvent(params: {
  batchId: string;
  event: OfflineStationEventDTO;
  requestHash: string;
  clockDriftSeconds: number;
}): Promise<OfflineReservation> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO public.production_station_offline_events (
         event_id, idempotency_key, request_hash, client_batch_id, event_type,
         occurred_at, device_id, operator_user_id, station_session_id, machine_id,
         payload, clock_drift_seconds, status, attempt_count, last_attempt_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,'PROCESSING',1,now())
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [
        params.event.event_id,
        params.event.idempotency_key,
        params.requestHash,
        params.batchId,
        params.event.type,
        params.event.occurred_at,
        params.event.device_id,
        params.event.user_id,
        params.event.station_session_id,
        params.event.machine_id,
        JSON.stringify(params.event.payload),
        params.clockDriftSeconds,
      ]
    );

    const found = await client.query<OfflineStoredOutcome & {
      idempotency_key: string;
      request_hash: string;
      lease_active: boolean;
    }>(
      `SELECT event_id::text, idempotency_key, request_hash, status,
              result_payload, error_code, error_message, server_entity_id::text,
              (status = 'PROCESSING' AND last_attempt_at > now() - interval '2 minutes') AS lease_active
         FROM public.production_station_offline_events
        WHERE event_id = $1::uuid OR idempotency_key = $2
        FOR UPDATE`,
      [params.event.event_id, params.event.idempotency_key]
    );

    const exact = found.rows.length === 1
      && found.rows[0]?.event_id === params.event.event_id
      && found.rows[0]?.idempotency_key === params.event.idempotency_key
      && found.rows[0]?.request_hash === params.requestHash;
    if (!exact) {
      await client.query("COMMIT");
      return { kind: "CONFLICT" };
    }

    const outcome = found.rows[0]!;
    if (inserted.rowCount === 0 && outcome.status === "PROCESSING") {
      if (outcome.lease_active) {
        await client.query("COMMIT");
        return { kind: "BUSY" };
      }
      await client.query(
        `UPDATE public.production_station_offline_events
            SET attempt_count = attempt_count + 1, last_attempt_at = now()
          WHERE event_id = $1::uuid`,
        [params.event.event_id]
      );
    }
    await client.query("COMMIT");
    return { kind: "RESERVED", existing: inserted.rowCount === 0, outcome };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function repoCompleteOfflineEvent(params: {
  eventId: string;
  requestHash: string;
  status: "SYNCED" | "REJECTED";
  serverEntityId?: string | null;
  resultPayload?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  const result = await pool.query(
    `UPDATE public.production_station_offline_events
        SET status = $3,
            server_entity_id = $4::uuid,
            result_payload = $5::jsonb,
            error_code = $6,
            error_message = $7,
            processed_at = now(),
            last_attempt_at = now()
      WHERE event_id = $1::uuid AND request_hash = $2 AND status = 'PROCESSING'`,
    [
      params.eventId,
      params.requestHash,
      params.status,
      params.serverEntityId ?? null,
      JSON.stringify(params.resultPayload ?? null),
      params.errorCode ?? null,
      params.errorMessage ?? null,
    ]
  );
  if (result.rowCount !== 1) {
    throw new Error(`Offline receipt ${params.eventId} could not be finalized`);
  }
}

export async function repoOfflineDependency(eventId: string): Promise<OfflineStoredOutcome | null> {
  const { rows } = await pool.query<OfflineStoredOutcome>(
    `SELECT event_id::text, status, result_payload, error_code, error_message,
            server_entity_id::text
       FROM public.production_station_offline_events
      WHERE event_id = $1::uuid`,
    [eventId]
  );
  return rows[0] ?? null;
}

export async function repoCanonicalIdempotencyExists(idempotencyKey: string): Promise<boolean> {
  const { rows } = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM public.production_execution_idempotency WHERE idempotency_key = $1
     ) AS present`,
    [idempotencyKey]
  );
  return rows[0]?.present === true;
}

export async function repoPurgeOfflineEvents(retentionDays: number): Promise<number> {
  const { rows } = await pool.query<{ purged: string | number }>(
    `SELECT public.fn_purge_production_station_offline_events($1::integer) AS purged`,
    [retentionDays]
  );
  return Number(rows[0]?.purged ?? 0);
}
