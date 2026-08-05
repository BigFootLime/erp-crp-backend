import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";

import type { OfflineStationEventDTO } from "../validators/offline-station.validators";

export type OfflineStoredOutcome = {
  event_id: string;
  status: "PROCESSING" | "SYNCED" | "REJECTED";
  result_payload: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  server_entity_id: string | null;
  execution_session_id: string | null;
};

type DbQueryer = Pick<PoolClient, "query">;

export type OfflineDependency = OfflineStoredOutcome & {
  client_batch_id: string;
  event_type: OfflineStationEventDTO["type"];
  device_id: string;
  operator_user_id: number;
  station_session_id: string;
  machine_id: string | null;
};

export type OfflineSourceSession = {
  id: string;
  device_id: string;
  user_id: number;
  machine_id: string | null;
  state: "ACTIVE" | "LOCKED" | "CLOSED" | "EXPIRED" | "REVOKED";
  started_at: string;
  closed_at: string | null;
  expires_at: string;
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
 * Reserve the transport claim. The canonical transaction locks this receipt
 * again before any effect and finalizes it in the same commit.
 */
export async function repoReserveOfflineEvent(params: {
  batchId: string;
  event: OfflineStationEventDTO;
  requestHash: string;
  clockDriftSeconds: number;
  executionSessionId: string | null;
  claimToken: string;
  authenticatedDeviceId: string;
  authenticatedOperatorUserId: number;
  authenticatedStationSessionId: string;
  authenticatedMachineId: string | null;
}): Promise<OfflineReservation> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO public.production_station_offline_events (
         event_id, idempotency_key, request_hash, client_batch_id, event_type,
         occurred_at, device_id, operator_user_id, station_session_id, machine_id,
         execution_session_id,
         authenticated_device_id, authenticated_operator_user_id,
         authenticated_station_session_id, authenticated_machine_id,
         payload, clock_drift_seconds, status, attempt_count, last_attempt_at,
         processing_token, lease_expires_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16::jsonb,$17,'PROCESSING',1,clock_timestamp(),$18,clock_timestamp() + interval '2 minutes'
       )
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
        params.executionSessionId,
        params.authenticatedDeviceId,
        params.authenticatedOperatorUserId,
        params.authenticatedStationSessionId,
        params.authenticatedMachineId,
        JSON.stringify(params.event.payload),
        params.clockDriftSeconds,
        params.claimToken,
      ]
    );

    const found = await client.query<OfflineStoredOutcome & {
      idempotency_key: string;
      request_hash: string;
      client_batch_id: string;
      authenticated_device_id: string;
      authenticated_operator_user_id: number;
      lease_active: boolean;
    }>(
      `SELECT event_id::text, idempotency_key, request_hash, client_batch_id::text, status,
              result_payload, error_code, error_message, server_entity_id::text,
              execution_session_id::text, authenticated_device_id::text,
              authenticated_operator_user_id,
              (status = 'PROCESSING' AND lease_expires_at > clock_timestamp()) AS lease_active
         FROM public.production_station_offline_events
        WHERE event_id = $1::uuid OR idempotency_key = $2
        FOR UPDATE`,
      [params.event.event_id, params.event.idempotency_key]
    );

    const exact = found.rows.length === 1
      && found.rows[0]?.event_id === params.event.event_id
      && found.rows[0]?.idempotency_key === params.event.idempotency_key
      && found.rows[0]?.client_batch_id === params.batchId
      && found.rows[0]?.execution_session_id === params.executionSessionId
      && found.rows[0]?.authenticated_device_id === params.authenticatedDeviceId
      && found.rows[0]?.authenticated_operator_user_id === params.authenticatedOperatorUserId
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
            SET attempt_count = attempt_count + 1,
                last_attempt_at = clock_timestamp(),
                processing_token = $2::uuid,
                lease_expires_at = clock_timestamp() + interval '2 minutes'
          WHERE event_id = $1::uuid AND status = 'PROCESSING'`,
        [params.event.event_id, params.claimToken]
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
  claimToken: string;
  status: "SYNCED" | "REJECTED";
  serverEntityId?: string | null;
  resultPayload?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}, tx?: DbQueryer): Promise<void> {
  const result = await (tx ?? pool).query(
    `UPDATE public.production_station_offline_events
        SET status = $3,
            server_entity_id = $4::uuid,
            result_payload = $5::jsonb,
            error_code = $6,
            error_message = $7,
            processed_at = now(),
            last_attempt_at = now()
      WHERE event_id = $1::uuid
        AND request_hash = $2
        AND processing_token = $8::uuid
        AND status = 'PROCESSING'`,
    [
      params.eventId,
      params.requestHash,
      params.status,
      params.serverEntityId ?? null,
      JSON.stringify(params.resultPayload ?? null),
      params.errorCode ?? null,
      params.errorMessage ?? null,
      params.claimToken,
    ]
  );
  if (result.rowCount !== 1) {
    throw new Error(`Offline receipt ${params.eventId} could not be finalized`);
  }
}

export async function repoAssertOfflineEventClaim(
  tx: DbQueryer,
  params: { eventId: string; requestHash: string; claimToken: string }
): Promise<void> {
  const result = await tx.query(
    `SELECT event_id
       FROM public.production_station_offline_events
      WHERE event_id = $1::uuid
        AND request_hash = $2
        AND processing_token = $3::uuid
        AND status = 'PROCESSING'
        AND lease_expires_at > clock_timestamp()
      FOR UPDATE`,
    [params.eventId, params.requestHash, params.claimToken]
  );
  if (result.rowCount !== 1) {
    throw new HttpError(
      503,
      "OFFLINE_EVENT_CLAIM_LOST",
      "Le bail de synchronisation a expiré; réessayez le même événement sans le modifier."
    );
  }
}

export async function repoReleaseOfflineEventClaim(params: {
  eventId: string;
  requestHash: string;
  claimToken: string;
}): Promise<void> {
  const result = await pool.query(
    `UPDATE public.production_station_offline_events
        SET lease_expires_at = GREATEST(received_at + interval '1 microsecond', clock_timestamp()),
            last_attempt_at = clock_timestamp()
      WHERE event_id = $1::uuid
        AND request_hash = $2
        AND processing_token = $3::uuid
        AND status = 'PROCESSING'`,
    [params.eventId, params.requestHash, params.claimToken]
  );
  if (result.rowCount !== 1) {
    throw new HttpError(
      503,
      "OFFLINE_EVENT_CLAIM_LOST",
      "Le bail de synchronisation a été repris; réessayez le même événement sans le modifier."
    );
  }
}

export async function repoOfflineDependency(eventId: string): Promise<OfflineDependency | null> {
  const { rows } = await pool.query<OfflineDependency>(
    `SELECT event_id::text, status, result_payload, error_code, error_message,
            server_entity_id::text, execution_session_id::text,
            client_batch_id::text, event_type,
            device_id::text, operator_user_id, station_session_id::text,
            machine_id::text
       FROM public.production_station_offline_events
      WHERE event_id = $1::uuid`,
    [eventId]
  );
  return rows[0] ?? null;
}

export async function repoOfflineSourceSession(sessionId: string): Promise<OfflineSourceSession | null> {
  const { rows } = await pool.query<OfflineSourceSession>(
    `SELECT id::text, device_id::text, user_id, machine_id::text, state,
            started_at::text, closed_at::text, expires_at::text
       FROM public.operator_device_sessions
      WHERE id = $1::uuid`,
    [sessionId]
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
