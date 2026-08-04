import crypto from "node:crypto";
import { Client, type PoolClient } from "pg";

import pool from "../../config/database";
import {
  moduleForRealtimeEntity,
  normalizeRealtimeModuleKey,
  normalizeRealtimeSubscription,
  realtimeSubscriptionKey,
  type RealtimeSubscription,
} from "./realtime-room-policy";
import {
  realtimeOutboxEventKey,
  trackInsertedRealtimeOutboxEvent,
  withRealtimeOutboxTransaction,
} from "./realtime-outbox-transaction";

const CONTROL_CHANNEL = "cerp_realtime_control";
const DEFAULT_RETENTION_HOURS = 24;
const MAX_READ_BATCH = 500;
const MAX_REPLAY_BATCH = 2_000;
const MAX_PUBLISH_ATTEMPTS = 3;
const OUTBOX_AGGREGATE_TYPE = "REALTIME";
const OUTBOX_EVENT_TYPE = "REALTIME.DISPATCH";
const REALTIME_ENQUEUE_ADVISORY_LOCK = "860804120012";
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_TARGET_COUNT = 16;
const MAX_QUARANTINE_ROWS = 1_000;

export type RealtimeControlSignal =
  | { kind: "event" }
  | { kind: "session_revoked"; userId: number }
  | { kind: "authorization_changed" }
  | { kind: "presence_changed"; userId: number; online: boolean }
  | { kind: "full_resync_required" };

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

export type RealtimeRetentionState = {
  latestSequence: bigint;
  earliestSequence: bigint | null;
  prunedThrough: bigint;
};

export type RealtimeReplayWindow = {
  retention: RealtimeRetentionState;
  records: RealtimeEventRecord[];
};

export class RealtimeCursorTooOldError extends Error {
  constructor(readonly prunedThrough: bigint) {
    super("REALTIME_CURSOR_TOO_OLD");
    this.name = "RealtimeCursorTooOldError";
  }
}

export type RealtimePrivilegedBackstopStatus = {
  installed: boolean;
  expectedCount: number;
  installedCount: number;
};

export type RealtimeControlPlaneIntegrityStatus = {
  valid: boolean;
  stateValid: boolean;
  provenanceValid: boolean;
  sequenceDefaultRemoved: boolean;
  constraintsValid: boolean;
};

export interface RealtimeControlPlane {
  latestSequence(): Promise<bigint>;
  /** Returns a bootstrap watermark only after all extant rows through it pass canonical validation. */
  validatedLatestSequence(): Promise<bigint>;
  retentionState?(): Promise<RealtimeRetentionState>;
  replayWindow?(sequence: bigint, limit?: number): Promise<RealtimeReplayWindow>;
  publish(input: PublishRealtimeEventInput): Promise<RealtimeEventRecord>;
  readAfter(sequence: bigint, limit?: number): Promise<RealtimeEventRecord[]>;
  flushOutbox?(limit?: number): Promise<number>;
  privilegedBackstopStatus?(): Promise<RealtimePrivilegedBackstopStatus>;
  /**
   * Invalidates every previously issued socket credential after a period in
   * which the privileged cross-writer triggers could not be proven healthy.
   * Readiness must remain suspended until this transaction commits.
   */
  reconcileAuthorizationAfterBackstopOutage(): Promise<void>;
  integrityStatus?(): Promise<RealtimeControlPlaneIntegrityStatus>;
  revokeSessions(userId: number): Promise<number>;
  subscribe(listener: (signal: RealtimeControlSignal) => void): Promise<() => Promise<void>>;
  pruneExpired(): Promise<number>;
}

export type RealtimeControlPlaneMetrics = {
  publishRetries: number;
  publishFailures: number;
  outboxFailures: number;
  listenerErrors: number;
  invalidStoredEvents: number;
  poisonRemediations: number;
  listenerReconnects: number;
};

const controlPlaneMetrics: RealtimeControlPlaneMetrics = {
  publishRetries: 0,
  publishFailures: 0,
  outboxFailures: 0,
  listenerErrors: 0,
  invalidStoredEvents: 0,
  poisonRemediations: 0,
  listenerReconnects: 0,
};

export type RealtimeDbQueryer = Pick<PoolClient, "query">;

/** Atomically changes the shared ACL revision and publishes its invalidation. */
export async function bumpRealtimeAuthorizationEpoch(tx: RealtimeDbQueryer): Promise<bigint> {
  const { rows } = await tx.query<{ epoch: string }>(
    `
      WITH bumped AS (
        UPDATE public.realtime_authorization_epoch
        SET epoch = epoch + 1,
            updated_at = clock_timestamp()
        WHERE singleton = true
        RETURNING epoch
      )
      SELECT
        epoch::text,
        pg_notify('cerp_realtime_control', '{"kind":"authorization_changed"}')
      FROM bumped
    `
  );
  const epoch = rows[0]?.epoch;
  if (!epoch) throw new Error("REALTIME_AUTHORIZATION_EPOCH_MISSING");
  return BigInt(epoch);
}

/** Atomically revokes one account's socket tokens and emits the shared signal. */
export async function bumpRealtimeSessionEpoch(tx: RealtimeDbQueryer, userId: number): Promise<number> {
  const { rows } = await tx.query<{ session_epoch: string }>(
    `
      WITH bumped AS (
        INSERT INTO public.realtime_session_epochs (user_id, session_epoch, updated_at)
        VALUES ($1, 1, clock_timestamp())
        ON CONFLICT (user_id) DO UPDATE
          SET session_epoch = public.realtime_session_epochs.session_epoch + 1,
              updated_at = clock_timestamp()
        RETURNING session_epoch
      )
      SELECT
        session_epoch::text,
        pg_notify(
          'cerp_realtime_control',
          json_build_object('kind', 'session_revoked', 'userId', $1::bigint)::text
        )
      FROM bumped
    `,
    [userId]
  );
  const epoch = Number.parseInt(rows[0]?.session_epoch ?? "", 10);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("REALTIME_SESSION_EPOCH_BUMP_FAILED");
  return epoch;
}

type StoredEventRow = {
  sequence: string;
  event_id: string;
  stream_id: string;
  event_name: string;
  payload: unknown;
  targets: unknown;
  occurred_at: Date | string;
  same_content?: boolean;
};

type OutboxRealtimeEnvelope = {
  schemaVersion: 1;
  eventId: string;
  input: PublishRealtimeEventInput;
};

type OutboxRow = {
  id: string;
  payload: unknown;
  realtime_stream_id: string | null;
  realtime_stream_ordinal: string | null;
};

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0);
}

function isNullableBoundedString(value: unknown, max: number): value is string | null {
  return value === null || isBoundedString(value, max, true);
}

function isIsoTimestamp(value: unknown): value is string {
  return isBoundedString(value, 64) && Number.isFinite(Date.parse(value));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function jsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : null;
  } catch {
    return null;
  }
}

function normalizeStoredTargets(value: unknown): RealtimeSubscription[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TARGET_COUNT) return null;
  const targets: RealtimeSubscription[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const target = normalizeRealtimeSubscription(candidate);
    if (!target) return null;
    const key = realtimeSubscriptionKey(target);
    if (seen.has(key)) return null;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

function validateEntityChangedPayload(payload: unknown, targets: readonly RealtimeSubscription[]): boolean {
  if (!isRecord(payload) || !hasExactKeys(payload, [
    "entityType", "entityId", "action", "module", "at", "invalidateKeys",
  ])) return false;
  if (!isBoundedString(payload.entityType, 64) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(payload.entityType)) return false;
  if (!isBoundedString(payload.entityId, 128) || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.entityId)) return false;
  if (!isBoundedString(payload.module, 64) || normalizeRealtimeModuleKey(payload.module) !== payload.module) return false;
  if (moduleForRealtimeEntity(payload.entityType) !== payload.module) return false;
  if (!["created", "updated", "deleted", "status_changed"].includes(String(payload.action))) return false;
  if (!isIsoTimestamp(payload.at)) return false;
  if (!Array.isArray(payload.invalidateKeys) || payload.invalidateKeys.length === 0 || payload.invalidateKeys.length > 32
      || payload.invalidateKeys.some((key) => !isBoundedString(key, 128))) return false;
  const moduleTarget = targets.filter((target) => target.scope === "module");
  const entityTarget = targets.filter((target) => target.scope === "entity");
  return targets.length === 2
    && moduleTarget.length === 1
    && moduleTarget[0]?.scope === "module"
    && moduleTarget[0].moduleKey === payload.module
    && entityTarget.length === 1
    && entityTarget[0]?.scope === "entity"
    && entityTarget[0].entityType === payload.entityType
    && entityTarget[0].entityId === payload.entityId;
}

function validateAuditNewPayload(payload: unknown, targets: readonly RealtimeSubscription[]): boolean {
  return isRecord(payload)
    && hasExactKeys(payload, ["auditId"])
    && isBoundedString(payload.auditId, 128)
    && targets.length === 1
    && targets[0]?.scope === "capability"
    && targets[0].capability === "audit:read";
}

function validateLockRef(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "entityType", "entityId", "lockedBy", "lockedAt", "expiresAt",
  ])) return false;
  if (!isBoundedString(value.id, 128) || !isBoundedString(value.entityType, 64)
      || !isBoundedString(value.entityId, 128) || !isIsoTimestamp(value.lockedAt)
      || !isIsoTimestamp(value.expiresAt) || !isRecord(value.lockedBy)
      || !hasExactKeys(value.lockedBy, ["id", "name"])) return false;
  return isPositiveSafeInteger(value.lockedBy.id) && isBoundedString(value.lockedBy.name, 256, true);
}

function validateLockUpdatedPayload(payload: unknown, targets: readonly RealtimeSubscription[]): boolean {
  if (!isRecord(payload) || !hasExactKeys(payload, ["entityType", "entityId", "locked", "lock"])
      || !isBoundedString(payload.entityType, 64) || !isBoundedString(payload.entityId, 128)
      || typeof payload.locked !== "boolean" || (payload.lock !== null && !validateLockRef(payload.lock))) return false;
  if (payload.locked !== (payload.lock !== null)) return false;
  if (isRecord(payload.lock)
      && (payload.lock.entityType !== payload.entityType || payload.lock.entityId !== payload.entityId)) return false;
  return targets.length === 1
    && targets[0]?.scope === "entity"
    && targets[0].entityType === payload.entityType
    && targets[0].entityId === payload.entityId;
}

function validateNotificationPayload(payload: unknown, targets: readonly RealtimeSubscription[]): boolean {
  if (!isRecord(payload) || !hasExactKeys(payload, [
    "id", "user_id", "kind", "title", "message", "severity", "action_url", "action_label",
    "payload", "created_at", "read_at",
  ])) return false;
  if (!isBoundedString(payload.id, 128) || !isPositiveSafeInteger(payload.user_id)
      || !isBoundedString(payload.kind, 128) || !isBoundedString(payload.title, 512)
      || !isBoundedString(payload.message, 8_192, true)
      || !["info", "success", "warning", "error"].includes(String(payload.severity))
      || !isNullableBoundedString(payload.action_url, 2_048)
      || !isNullableBoundedString(payload.action_label, 256)
      || !isRecord(payload.payload) || !isIsoTimestamp(payload.created_at)
      || (payload.read_at !== null && !isIsoTimestamp(payload.read_at))) return false;
  return targets.length === 1 && targets[0]?.scope === "user" && targets[0].userId === payload.user_id;
}

function validateChatSender(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["id", "username", "name", "surname"])
    && isPositiveSafeInteger(value.id)
    && isBoundedString(value.username, 256)
    && isNullableBoundedString(value.name, 256)
    && isNullableBoundedString(value.surname, 256);
}

function validateChatMessagePayload(payload: unknown, targets: readonly RealtimeSubscription[]): boolean {
  if (!isRecord(payload) || !hasExactKeys(payload, ["conversation_id", "message", "sender"])
      || !isBoundedString(payload.conversation_id, 128) || !isRecord(payload.message)
      || !hasExactKeys(payload.message, [
        "id", "conversation_id", "sender_user_id", "message_type", "content", "created_at",
      ]) || !isBoundedString(payload.message.id, 128)
      || payload.message.conversation_id !== payload.conversation_id
      || !isPositiveSafeInteger(payload.message.sender_user_id)
      || payload.message.message_type !== "text"
      || !isBoundedString(payload.message.content, 32_768, true)
      || !isIsoTimestamp(payload.message.created_at)
      || !validateChatSender(payload.sender)) return false;
  return targets.length === 1 && targets[0]?.scope === "user";
}

function validateChatReadPayload(payload: unknown, targets: readonly RealtimeSubscription[]): boolean {
  return isRecord(payload)
    && hasExactKeys(payload, ["conversation_id", "read_at"])
    && isBoundedString(payload.conversation_id, 128)
    && isIsoTimestamp(payload.read_at)
    && targets.length === 1
    && targets[0]?.scope === "user";
}

function validateChatUpsertPayload(payload: unknown, targets: readonly RealtimeSubscription[]): boolean {
  return isRecord(payload)
    && hasExactKeys(payload, ["conversation_id", "type", "group_name"])
    && isBoundedString(payload.conversation_id, 128)
    && (payload.type === "direct" || payload.type === "group")
    && isNullableBoundedString(payload.group_name, 512)
    && (payload.type === "group" || payload.group_name === null)
    && targets.length === 1
    && targets[0]?.scope === "user";
}

function validateRealtimeEventContract(
  event: string,
  payload: unknown,
  targets: readonly RealtimeSubscription[]
): boolean {
  const bytes = jsonByteLength(payload);
  if (bytes === null || bytes > MAX_PAYLOAD_BYTES) return false;
  switch (event) {
    case "entity:changed": return validateEntityChangedPayload(payload, targets);
    case "audit:new": return validateAuditNewPayload(payload, targets);
    case "lock:updated": return validateLockUpdatedPayload(payload, targets);
    case "app-notification:created": return validateNotificationPayload(payload, targets);
    case "chat:message:created": return validateChatMessagePayload(payload, targets);
    case "chat:conversation:read": return validateChatReadPayload(payload, targets);
    case "chat:conversation:upsert": return validateChatUpsertPayload(payload, targets);
    default: return false;
  }
}

function parseStoredEvent(row: StoredEventRow): RealtimeEventRecord | null {
  const targets = normalizeStoredTargets(row.targets);
  let sequence: bigint;
  try {
    sequence = BigInt(row.sequence);
  } catch {
    return null;
  }
  if (
    sequence <= 0n
    || typeof row.event_id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.event_id)
    || typeof row.stream_id !== "string"
    || row.stream_id.trim().length === 0
    || row.stream_id.length > 256
    || typeof row.event_name !== "string"
    || !/^[a-zA-Z][a-zA-Z0-9:_-]{0,127}$/.test(row.event_name)
    || !targets
    || !validateRealtimeEventContract(row.event_name, row.payload, targets)
  ) return null;
  const occurredAt = new Date(row.occurred_at);
  if (!Number.isFinite(occurredAt.getTime())) return null;
  return {
    sequence,
    eventId: row.event_id,
    streamId: row.stream_id,
    event: row.event_name,
    payload: row.payload,
    targets,
    occurredAt: occurredAt.toISOString(),
  };
}

function parsePublishInput(value: unknown): PublishRealtimeEventInput | null {
  if (!isRecord(value)) return null;
  const targets = normalizeStoredTargets(value.targets);
  if (
    typeof value.event !== "string"
    || !/^[a-zA-Z][a-zA-Z0-9:_-]{0,127}$/.test(value.event)
    || typeof value.streamId !== "string"
    || value.streamId.length === 0
    || value.streamId.length > 256
    || !targets
    || !validateRealtimeEventContract(value.event, value.payload, targets)
    || (value.deduplicationKey !== undefined
      && (!isBoundedString(value.deduplicationKey, 256) || value.deduplicationKey.trim() !== value.deduplicationKey))
  ) return null;
  return {
    event: value.event,
    payload: value.payload,
    targets,
    streamId: value.streamId,
    ...(typeof value.deduplicationKey === "string" ? { deduplicationKey: value.deduplicationKey } : {}),
  };
}

function parseOutboxEnvelope(value: unknown): OutboxRealtimeEnvelope | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.eventId !== "string" || !isRecord(value.input)) {
    return null;
  }
  const input = parsePublishInput(value.input);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.eventId)
    || !input
  ) return null;
  return {
    schemaVersion: 1,
    eventId: value.eventId,
    input,
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

/**
 * Enqueues a realtime event using the caller's business transaction. The
 * stable event id plus unique event key makes delivery restart-safe.
 */
export async function enqueueRealtimeEvent(
  tx: RealtimeDbQueryer,
  input: PublishRealtimeEventInput & { deduplicationKey: string }
): Promise<string> {
  const eventId = crypto.randomUUID();
  const deduplicationKey = input.deduplicationKey.trim();
  if (!deduplicationKey) throw new Error("REALTIME_OUTBOX_DEDUPLICATION_KEY_REQUIRED");
  const canonicalInput = parsePublishInput({ ...input, deduplicationKey });
  if (!canonicalInput) throw new Error("INVALID_REALTIME_EVENT_INPUT");
  const envelope: OutboxRealtimeEnvelope = {
    schemaVersion: 1,
    eventId,
    input: canonicalInput,
  };
  const eventKey = realtimeOutboxEventKey(deduplicationKey);

  // One transaction-scoped lock is intentionally shared by every realtime
  // enqueue, including the privileged audit trigger. Besides making the stream
  // ordinal allocation deterministic, this removes the A->B/B->A deadlock
  // class for transactions that publish to several streams in opposite order.
  await tx.query(`SELECT pg_advisory_xact_lock(${REALTIME_ENQUEUE_ADVISORY_LOCK}::bigint)`);

  const existing = await tx.query<{ event_id: string; same_content: boolean }>(
    `
      SELECT
        correlation_id::text AS event_id,
        payload -> 'input' = $2::jsonb AS same_content
      FROM public.erp_outbox_events
      WHERE event_key = $1
      LIMIT 1
    `,
    [eventKey, JSON.stringify(canonicalInput)]
  );
  if (existing.rows[0]) {
    if (existing.rows[0].same_content !== true) throw new Error("REALTIME_OUTBOX_KEY_COLLISION");
    return existing.rows[0].event_id;
  }

  const ordinalResult = await tx.query<{ stream_ordinal: string }>(
    `
      INSERT INTO public.realtime_stream_enqueue_state (stream_id, next_ordinal, updated_at)
      VALUES ($1, 2, clock_timestamp())
      ON CONFLICT (stream_id) DO UPDATE
      SET next_ordinal = public.realtime_stream_enqueue_state.next_ordinal + 1,
          updated_at = clock_timestamp()
      RETURNING (next_ordinal - 1)::text AS stream_ordinal
    `,
    [canonicalInput.streamId]
  );
  const streamOrdinal = ordinalResult.rows[0]?.stream_ordinal;
  if (!streamOrdinal) throw new Error("REALTIME_STREAM_ORDINAL_ALLOCATION_FAILED");

  const { rows } = await tx.query<{ event_id: string }>(
    `
      INSERT INTO public.erp_outbox_events (
        event_key,
        aggregate_type,
        aggregate_id,
        event_type,
        payload,
        correlation_id,
        status,
        available_at,
        realtime_stream_id,
        realtime_stream_ordinal
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::uuid, 'PENDING', now(), $7, $8::bigint)
      RETURNING correlation_id::text AS event_id
    `,
    [
      realtimeOutboxEventKey(deduplicationKey),
      OUTBOX_AGGREGATE_TYPE,
      canonicalInput.streamId,
      OUTBOX_EVENT_TYPE,
      JSON.stringify(envelope),
      eventId,
      canonicalInput.streamId,
      streamOrdinal,
    ]
  );
  const storedEventId = rows[0]?.event_id;
  if (!storedEventId) throw new Error("REALTIME_OUTBOX_KEY_COLLISION");
  trackInsertedRealtimeOutboxEvent(tx, { eventKey, eventId: storedEventId });
  return storedEventId;
}

async function findStoredEvent(
  tx: RealtimeDbQueryer,
  deduplicationKey: string,
  input: PublishRealtimeEventInput
): Promise<RealtimeEventRecord | null> {
  const { rows } = await tx.query<StoredEventRow>(
    `
      SELECT
        sequence::text,
        event_id::text,
        stream_id,
        event_name,
        payload,
        targets,
        occurred_at,
        (
          event_name = $2
          AND stream_id = $3
          AND payload = $4::jsonb
          AND targets = $5::jsonb
        ) AS same_content
      FROM public.realtime_event_log
      WHERE deduplication_key = $1
      LIMIT 1
    `,
    [
      deduplicationKey,
      input.event,
      input.streamId,
      JSON.stringify(input.payload ?? null),
      JSON.stringify(input.targets),
    ]
  );
  const row = rows[0];
  if (!row) return null;
  if (row.same_content !== true) throw new Error("REALTIME_EVENT_KEY_COLLISION");
  return parseStoredEvent(row);
}

async function readRetentionState(tx: RealtimeDbQueryer): Promise<RealtimeRetentionState> {
  const { rows } = await tx.query<{
    latest_sequence: string;
    earliest_sequence: string | null;
    pruned_through: string;
    max_event_sequence: string | null;
  }>(
    `
      SELECT
        state.last_sequence::text AS latest_sequence,
        (MIN(event.sequence) FILTER (WHERE event.expires_at > now()))::text AS earliest_sequence,
        GREATEST(
          state.pruned_through,
          COALESCE(MAX(event.sequence) FILTER (WHERE event.expires_at <= now()), 0)
        )::text AS pruned_through,
        MAX(event.sequence)::text AS max_event_sequence
      FROM public.realtime_event_sequence_state state
      LEFT JOIN public.realtime_event_log event ON true
      WHERE state.singleton = true
      GROUP BY state.last_sequence, state.pruned_through
    `
  );
  const row = rows[0];
  if (!row) throw new Error("REALTIME_SEQUENCE_STATE_MISSING");
  const latestSequence = BigInt(row.latest_sequence);
  const prunedThrough = BigInt(row.pruned_through);
  const maxEventSequence = row.max_event_sequence === null ? 0n : BigInt(row.max_event_sequence);
  if (
    latestSequence < 0n
    || prunedThrough < 0n
    || prunedThrough > latestSequence
    || latestSequence < maxEventSequence
  ) throw new Error("REALTIME_SEQUENCE_STATE_CORRUPT");
  return {
    latestSequence,
    earliestSequence: row.earliest_sequence === null ? null : BigInt(row.earliest_sequence),
    prunedThrough,
  };
}

/**
 * The singleton row is locked until COMMIT. A transaction cannot allocate N+1
 * until the transaction holding N has committed or rolled back, so visible
 * sequence order is commit order (the guarantee nextval()/bigserial lacks).
 */
async function insertEventInTransaction(
  tx: RealtimeDbQueryer,
  input: PublishRealtimeEventInput,
  eventId: string,
  deduplicationKey: string
): Promise<{ record: RealtimeEventRecord; inserted: boolean }> {
  await tx.query(
    "SELECT last_sequence FROM public.realtime_event_sequence_state WHERE singleton = true FOR UPDATE"
  );
  const existing = await findStoredEvent(tx, deduplicationKey, input);
  if (existing) return { record: existing, inserted: false };

  const sequenceResult = await tx.query<{ sequence: string }>(
    `
      UPDATE public.realtime_event_sequence_state
      SET last_sequence = last_sequence + 1
      WHERE singleton = true
      RETURNING last_sequence::text AS sequence
    `
  );
  const sequence = sequenceResult.rows[0]?.sequence;
  if (!sequence) throw new Error("REALTIME_SEQUENCE_STATE_MISSING");

  const retentionHours = positiveIntEnv("REALTIME_EVENT_RETENTION_HOURS", DEFAULT_RETENTION_HOURS);
  const { rows } = await tx.query<StoredEventRow>(
    `
      INSERT INTO public.realtime_event_log
        (sequence, event_id, deduplication_key, stream_id, event_name, payload, targets, expires_at)
      VALUES
        ($1::bigint, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, now() + ($8::text || ' hours')::interval)
      RETURNING sequence::text, event_id::text, stream_id, event_name, payload, targets, occurred_at
    `,
    [
      sequence,
      eventId,
      deduplicationKey,
      input.streamId,
      input.event,
      JSON.stringify(input.payload ?? null),
      JSON.stringify(input.targets),
      retentionHours,
    ]
  );
  const record = rows[0] ? parseStoredEvent(rows[0]) : null;
  if (!record) throw new Error("INVALID_REALTIME_EVENT_ROW");
  return { record, inserted: true };
}

async function publishOnce(
  input: PublishRealtimeEventInput,
  eventId: string,
  deduplicationKey: string
): Promise<RealtimeEventRecord> {
  const client = await pool.connect();
  let transactionOpen = false;
  let commitAttempted = false;
  let destroyConnection = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const { record, inserted } = await insertEventInTransaction(client, input, eventId, deduplicationKey);
    if (inserted) {
      await client.query("SELECT pg_notify($1, $2)", [CONTROL_CHANNEL, JSON.stringify({ kind: "event" })]);
    }
    commitAttempted = true;
    await client.query("COMMIT");
    transactionOpen = false;
    return record;
  } catch (error) {
    if (commitAttempted) {
      // The server may have committed even though its acknowledgement was
      // lost. Never return this protocol-uncertain connection to the pool;
      // publish() retries with the same event id and deduplication key.
      destroyConnection = true;
    } else if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        destroyConnection = true;
      }
    } else {
      destroyConnection = true;
    }
    throw error;
  } finally {
    client.release(destroyConnection);
  }
}

function privacySafeContentHash(value: unknown): string {
  let serialized = "unserializable";
  try {
    serialized = JSON.stringify(value) ?? "undefined";
  } catch {
    // The hash remains deterministic and no payload is copied to logs/quarantine.
  }
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

async function recordQuarantine(
  tx: RealtimeDbQueryer,
  input: { source: "event_log" | "outbox"; sourceId: string; sequence: bigint | null; reason: string; content: unknown }
): Promise<void> {
  await tx.query(
    `
      INSERT INTO public.realtime_event_quarantine
        (source, source_id, sequence, reason, content_hash)
      VALUES ($1, $2, $3::bigint, $4, $5)
      ON CONFLICT (source, source_id, reason) DO UPDATE
      SET quarantined_at = clock_timestamp(),
          expires_at = clock_timestamp() + interval '7 days',
          content_hash = EXCLUDED.content_hash
    `,
    [input.source, input.sourceId, input.sequence?.toString() ?? null, input.reason, privacySafeContentHash(input.content)]
  );
  await tx.query("DELETE FROM public.realtime_event_quarantine WHERE expires_at <= now()");
  await tx.query(
    `
      DELETE FROM public.realtime_event_quarantine
      WHERE id IN (
        SELECT id
        FROM public.realtime_event_quarantine
        ORDER BY quarantined_at DESC, id DESC
        OFFSET $1
      )
    `,
    [MAX_QUARANTINE_ROWS]
  );
}

async function forceFullResyncBarrier(tx: RealtimeDbQueryer): Promise<bigint> {
  const { rows } = await tx.query<{ barrier: string }>(
    `
      UPDATE public.realtime_event_sequence_state
      SET last_sequence = last_sequence + 1,
          pruned_through = last_sequence + 1
      WHERE singleton = true
      RETURNING last_sequence::text AS barrier
    `
  );
  const barrier = rows[0]?.barrier;
  if (!barrier) throw new Error("REALTIME_SEQUENCE_STATE_MISSING");
  await tx.query("SELECT pg_notify($1, $2)", [CONTROL_CHANNEL, JSON.stringify({ kind: "full_resync_required" })]);
  controlPlaneMetrics.poisonRemediations += 1;
  return BigInt(barrier);
}

async function quarantineOutboxAndForceResync(
  tx: RealtimeDbQueryer,
  row: OutboxRow,
  reason: "INVALID_REALTIME_ENVELOPE" | "REALTIME_OUTBOX_STREAM_MISMATCH"
): Promise<void> {
  await recordQuarantine(tx, {
    source: "outbox",
    sourceId: row.id,
    sequence: null,
    reason,
    content: row.payload,
  });
  await tx.query(
    `
      UPDATE public.erp_outbox_events
      SET status = 'PUBLISHED',
          attempt_count = attempt_count + 1,
          published_at = COALESCE(published_at, now()),
          available_at = 'infinity'::timestamptz,
          last_error = $2
      WHERE id = $1::uuid
    `,
    [row.id, `QUARANTINED:${reason}`]
  );
  await forceFullResyncBarrier(tx);
}

export class PostgresRealtimeControlPlane implements RealtimeControlPlane {
  async latestSequence(): Promise<bigint> {
    const state = await this.retentionState();
    return state.latestSequence;
  }

  async validatedLatestSequence(): Promise<bigint> {
    const client = await pool.connect();
    let transactionOpen = false;
    let released = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      transactionOpen = true;
      await client.query(
        "SELECT last_sequence FROM public.realtime_event_sequence_state WHERE singleton = true FOR UPDATE"
      );
      const retention = await readRetentionState(client);
      let cursor = retention.prunedThrough;
      while (cursor < retention.latestSequence) {
        const { rows } = await client.query<StoredEventRow>(
          `
            SELECT sequence::text, event_id::text, stream_id, event_name, payload, targets, occurred_at
            FROM public.realtime_event_log
            WHERE sequence > $1::bigint
              AND sequence <= $2::bigint
            ORDER BY sequence ASC
            LIMIT $3
          `,
          [cursor.toString(), retention.latestSequence.toString(), MAX_READ_BATCH]
        );
        if (rows.length === 0) {
          const expected = cursor + 1n;
          await recordQuarantine(client, {
            source: "event_log",
            sourceId: `gap:${expected.toString()}`,
            sequence: expected,
            reason: "SEQUENCE_GAP",
            content: { expected: expected.toString(), latest: retention.latestSequence.toString() },
          });
          controlPlaneMetrics.invalidStoredEvents += 1;
          const barrier = await forceFullResyncBarrier(client);
          await client.query("COMMIT");
          transactionOpen = false;
          return barrier;
        }
        for (const row of rows) {
          const expected = cursor + 1n;
          let actual: bigint | null = null;
          try {
            actual = BigInt(row.sequence);
          } catch {
            // A non-bigint sequence cannot normally cross the DB boundary, but
            // the same fail-closed remediation path remains explicit.
          }
          if (actual !== expected) {
            await recordQuarantine(client, {
              source: "event_log",
              sourceId: `gap:${expected.toString()}`,
              sequence: expected,
              reason: "SEQUENCE_GAP",
              content: { expected: expected.toString(), actual: actual?.toString() ?? "invalid" },
            });
            controlPlaneMetrics.invalidStoredEvents += 1;
            const barrier = await forceFullResyncBarrier(client);
            await client.query("COMMIT");
            transactionOpen = false;
            return barrier;
          }
          if (!parseStoredEvent(row)) {
            await recordQuarantine(client, {
              source: "event_log",
              sourceId: row.event_id || `sequence:${row.sequence}`,
              sequence: actual,
              reason: "INVALID_STORED_EVENT",
              content: row,
            });
            await client.query("DELETE FROM public.realtime_event_log WHERE sequence = $1::bigint", [row.sequence]);
            controlPlaneMetrics.invalidStoredEvents += 1;
            const barrier = await forceFullResyncBarrier(client);
            await client.query("COMMIT");
            transactionOpen = false;
            return barrier;
          }
          cursor = actual;
        }
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return retention.latestSequence;
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
      client.release(error instanceof Error ? error : true);
      released = true;
      throw error;
    } finally {
      if (!released) client.release();
    }
  }

  async retentionState(): Promise<RealtimeRetentionState> {
    return readRetentionState(pool);
  }

  async integrityStatus(): Promise<RealtimeControlPlaneIntegrityStatus> {
    const { rows } = await pool.query<{
      provenance_valid: boolean;
      sequence_default_removed: boolean;
      constraints_valid: boolean;
    }>(
      `
        SELECT
          (
            SELECT COUNT(*) = 1
              AND BOOL_AND(initial_pruned_through BETWEEN 0 AND initial_last_sequence)
              AND BOOL_AND(baseline_event_count >= 0)
              AND BOOL_AND(
                (baseline_event_count = 0 AND baseline_event_min IS NULL AND baseline_event_max IS NULL)
                OR
                (baseline_event_count > 0 AND baseline_event_min IS NOT NULL
                  AND baseline_event_max IS NOT NULL AND baseline_event_min <= baseline_event_max)
              )
              AND BOOL_AND(
                (NOT inherited_v1
                  AND source_v1_sha256 IS NULL
                  AND initial_last_sequence = 0
                  AND initial_pruned_through = 0
                  AND NOT EXISTS (
                    SELECT 1 FROM public.cerp_schema_migrations
                    WHERE filename = '20260804_realtime_shared_control_plane.sql'
                  ))
                OR
                (inherited_v1
                  AND source_v1_sha256 = 'a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6'
                  AND EXISTS (
                    SELECT 1 FROM public.cerp_schema_migrations
                    WHERE filename = '20260804_realtime_shared_control_plane.sql'
                      AND sha256 = 'a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6'
                      AND applied_at IS NOT NULL
                  )
                  AND initial_last_sequence = initial_pruned_through
                  AND initial_last_sequence > GREATEST(COALESCE(baseline_event_max, 0), 0))
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.cerp_schema_migrations
                WHERE filename = '20260804_realtime_shared_control_plane.sql'
                  AND sha256 <> 'a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6'
              )
            FROM public.realtime_control_plane_v2_provenance
            WHERE singleton = true
          ) AS provenance_valid,
          COALESCE((
            SELECT column_default IS NULL
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'realtime_event_log'
              AND column_name = 'sequence'
          ), false) AS sequence_default_removed,
          (
            (SELECT COUNT(*) = 7
             FROM pg_constraint
             WHERE conrelid = 'public.realtime_event_log'::regclass
               AND convalidated
               AND conname = ANY(ARRAY[
                 'realtime_event_log_pkey',
                 'realtime_event_log_event_id_uq',
                 'realtime_event_log_deduplication_key_uq',
                 'realtime_event_log_stream_ck',
                 'realtime_event_log_name_ck',
                 'realtime_event_log_targets_ck',
                 'realtime_event_log_retention_ck'
               ]::text[]))
            AND to_regclass('public.realtime_chat_presence') IS NOT NULL
            AND (SELECT COUNT(*) = 2
                 FROM pg_constraint
                 WHERE conrelid = to_regclass('public.realtime_chat_presence')
                   AND convalidated
                   AND conname = ANY(ARRAY[
                     'realtime_chat_presence_expiry_ck',
                     'realtime_chat_presence_user_ck'
                   ]::text[]))
            AND to_regclass('public.realtime_stream_enqueue_state') IS NOT NULL
            AND to_regclass('public.realtime_event_quarantine') IS NOT NULL
            AND to_regclass('public.erp_outbox_events_realtime_stream_ordinal_uq') IS NOT NULL
            AND (SELECT COUNT(*) = 2
                 FROM pg_constraint
                 WHERE conrelid = 'public.erp_outbox_events'::regclass
                   AND convalidated
                   AND conname = ANY(ARRAY[
                     'erp_outbox_events_realtime_pair_ck',
                     'erp_outbox_events_realtime_required_ck'
                   ]::text[]))
          ) AS constraints_valid
      `
    );
    const row = rows[0];
    const stateValid = await this.retentionState().then(() => true, () => false);
    const provenanceValid = row?.provenance_valid === true;
    const sequenceDefaultRemoved = row?.sequence_default_removed === true;
    const constraintsValid = row?.constraints_valid === true;
    return {
      valid: stateValid && provenanceValid && sequenceDefaultRemoved && constraintsValid,
      stateValid,
      provenanceValid,
      sequenceDefaultRemoved,
      constraintsValid,
    };
  }

  async privilegedBackstopStatus(): Promise<RealtimePrivilegedBackstopStatus> {
    const { rows } = await pool.query<{ expected_count: number; installed_count: number }>(
      `
        WITH expected_triggers(trigger_name, relation_name, function_name, trigger_type, required_definition) AS (
          VALUES
            ('users_realtime_session_update_trg', 'public.users', 'public.cerp_realtime_bump_session_epoch()', 17, 'UPDATE OF password, role, status, is_superadmin'),
            ('users_realtime_session_delete_trg', 'public.users', 'public.cerp_realtime_bump_session_epoch()', 9, 'AFTER DELETE'),
            ('user_role_assignments_realtime_session_trg', 'public.user_role_assignments', 'public.cerp_realtime_bump_session_epoch()', 29, 'AFTER INSERT OR DELETE OR UPDATE'),
            ('users_realtime_authorization_epoch_trg', 'public.users', 'public.cerp_realtime_bump_authorization_epoch()', 17, 'UPDATE OF role, status, is_superadmin'),
            ('app_modules_realtime_authorization_epoch_trg', 'public.app_modules', 'public.cerp_realtime_bump_authorization_epoch()', 28, 'AFTER INSERT OR DELETE OR UPDATE'),
            ('app_module_user_access_realtime_authorization_epoch_trg', 'public.app_module_user_access', 'public.cerp_realtime_bump_authorization_epoch()', 28, 'AFTER INSERT OR DELETE OR UPDATE'),
            ('user_role_assignments_realtime_authorization_epoch_trg', 'public.user_role_assignments', 'public.cerp_realtime_bump_authorization_epoch()', 28, 'AFTER INSERT OR DELETE OR UPDATE'),
            ('erp_audit_logs_realtime_outbox_trg', 'public.erp_audit_logs', 'public.cerp_realtime_enqueue_audit_event()', 5, 'AFTER INSERT')
        ),
        trigger_status AS (
          SELECT
            COUNT(*)::int AS expected_count,
            COUNT(*) FILTER (
              WHERE trigger.oid IS NOT NULL
                AND trigger.tgenabled IN ('O', 'A')
                AND trigger.tgfoid = to_regprocedure(expected.function_name)
                AND trigger.tgtype = expected.trigger_type
                AND position(expected.required_definition IN pg_get_triggerdef(trigger.oid)) > 0
            )::int AS installed_count
          FROM expected_triggers expected
          LEFT JOIN pg_trigger trigger
            ON trigger.tgname = expected.trigger_name
           AND trigger.tgrelid = to_regclass(expected.relation_name)
           AND NOT trigger.tgisinternal
        ),
        expected_functions(function_name, normalized_body_md5) AS (
          VALUES
            ('public.cerp_realtime_bump_session_epoch()'::text, 'eaa359d0643f761d7e8715e5a1206c4b'::text),
            ('public.cerp_realtime_bump_authorization_epoch()'::text, '70c4324341adf301e9d3c8764819b641'::text),
            ('public.cerp_realtime_enqueue_audit_event()'::text, 'baf6cd29532fad08842655261bed08c6'::text)
        ),
        function_status AS (
          SELECT
            COUNT(*)::int AS expected_count,
            COUNT(*) FILTER (
              WHERE procedure.oid IS NOT NULL
                AND procedure.prosecdef
                AND procedure.prokind = 'f'
                AND procedure.provolatile = 'v'
                AND NOT procedure.proisstrict
                AND procedure.pronargs = 0
                AND procedure.prorettype = 'pg_catalog.trigger'::regtype
                AND procedure.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                AND pg_get_userbyid(procedure.proowner) = 'postgres'
                AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
                AND md5(btrim(regexp_replace(procedure.prosrc, '[[:space:]]+', ' ', 'g'))) = expected.normalized_body_md5
                AND NOT EXISTS (
                  SELECT 1
                  FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) privilege
                  WHERE privilege.grantee <> procedure.proowner
                )
            )::int AS installed_count
          FROM expected_functions expected
          LEFT JOIN pg_proc procedure ON procedure.oid = to_regprocedure(expected.function_name)
        )
        SELECT
          trigger_status.expected_count + function_status.expected_count AS expected_count,
          trigger_status.installed_count + function_status.installed_count AS installed_count
        FROM trigger_status CROSS JOIN function_status
      `
    );
    const expectedCount = rows[0]?.expected_count ?? 11;
    const installedCount = rows[0]?.installed_count ?? 0;
    return { installed: installedCount === expectedCount, expectedCount, installedCount };
  }

  async reconcileAuthorizationAfterBackstopOutage(): Promise<void> {
    const client = await pool.connect();
    await withRealtimeOutboxTransaction(client, async (tx) => {
      await tx.query(
        `
          INSERT INTO public.realtime_session_epochs (user_id, session_epoch, updated_at)
          SELECT users.id, 1, clock_timestamp()
          FROM public.users
          ON CONFLICT (user_id) DO UPDATE
            SET session_epoch = public.realtime_session_epochs.session_epoch + 1,
                updated_at = clock_timestamp()
        `
      );
      await bumpRealtimeAuthorizationEpoch(tx);
    });
  }

  async replayWindow(sequence: bigint, limit = MAX_REPLAY_BATCH): Promise<RealtimeReplayWindow> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), MAX_REPLAY_BATCH));
    await this.validatedLatestSequence();
    const client = await pool.connect();
    let transactionOpen = false;
    let released = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionOpen = true;
      const retention = await readRetentionState(client);
      if (sequence < retention.prunedThrough) {
        await client.query("COMMIT");
        transactionOpen = false;
        return { retention, records: [] };
      }
      const { rows } = await client.query<StoredEventRow>(
        `
          SELECT sequence::text, event_id::text, stream_id, event_name, payload, targets, occurred_at
          FROM public.realtime_event_log
          WHERE sequence > $1::bigint
            AND sequence <= $2::bigint
            AND expires_at > now()
          ORDER BY sequence ASC
          LIMIT $3
        `,
        [sequence.toString(), retention.latestSequence.toString(), boundedLimit]
      );
      const records: RealtimeEventRecord[] = [];
      for (const row of rows) {
        const event = parseStoredEvent(row);
        if (!event) {
          controlPlaneMetrics.invalidStoredEvents += 1;
          throw new Error("INVALID_REALTIME_STORED_EVENT");
        }
        records.push(event);
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return { retention, records };
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
      client.release(error instanceof Error ? error : true);
      released = true;
      throw error;
    } finally {
      if (!released) client.release();
    }
  }

  async publish(input: PublishRealtimeEventInput): Promise<RealtimeEventRecord> {
    const canonicalInput = parsePublishInput(input);
    if (!canonicalInput) throw new Error("INVALID_REALTIME_EVENT_INPUT");
    const eventId = crypto.randomUUID();
    const deduplicationKey = canonicalInput.deduplicationKey?.trim() || eventId;
    let lastError: unknown;
    let attempts = 0;
    for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      try {
        return await publishOnce(canonicalInput, eventId, deduplicationKey);
      } catch (error) {
        lastError = error;
        if (attempt === MAX_PUBLISH_ATTEMPTS || !isRetryablePublishError(error)) break;
        controlPlaneMetrics.publishRetries += 1;
        console.warn(JSON.stringify({
          type: "realtime_publish_retry",
          event: canonicalInput.event,
          attempt,
          error: privacySafeErrorName(error),
        }));
        await retryDelay(attempt);
      }
    }
    controlPlaneMetrics.publishFailures += 1;
    console.error(JSON.stringify({
      type: "realtime_publish_failed",
      event: canonicalInput.event,
      attempts,
      error: privacySafeErrorName(lastError),
    }));
    throw lastError;
  }

  async readAfter(sequence: bigint, limit = MAX_READ_BATCH): Promise<RealtimeEventRecord[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), MAX_READ_BATCH));
    await this.validatedLatestSequence();
    const retention = await this.retentionState();
    if (sequence < retention.prunedThrough) {
      throw new RealtimeCursorTooOldError(retention.prunedThrough);
    }
    const { rows } = await pool.query<StoredEventRow>(
      `
        SELECT sequence::text, event_id::text, stream_id, event_name, payload, targets, occurred_at
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
      if (!event) {
        controlPlaneMetrics.invalidStoredEvents += 1;
        throw new Error("INVALID_REALTIME_STORED_EVENT");
      }
      parsed.push(event);
    }
    return parsed;
  }

  async flushOutbox(limit = MAX_READ_BATCH): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), MAX_READ_BATCH));
    let published = 0;
    for (let index = 0; index < boundedLimit; index += 1) {
      const client = await pool.connect();
      let outboxId: string | null = null;
      let transactionOpen = false;
      let commitAttempted = false;
      let destroyConnection = false;
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        const { rows } = await client.query<OutboxRow>(
          `
            SELECT
              candidate.id::text AS id,
              candidate.payload,
              candidate.realtime_stream_id,
              candidate.realtime_stream_ordinal::text
            FROM public.erp_outbox_events candidate
            WHERE candidate.aggregate_type = $1
              AND candidate.event_type = $2
              AND candidate.status IN ('PENDING', 'FAILED')
              AND candidate.available_at <= now()
              AND (
                candidate.realtime_stream_id IS NULL
                OR candidate.realtime_stream_ordinal IS NULL
                OR NOT EXISTS (
                  SELECT 1
                  FROM public.erp_outbox_events predecessor
                  WHERE predecessor.aggregate_type = candidate.aggregate_type
                    AND predecessor.event_type = candidate.event_type
                    AND predecessor.realtime_stream_id = candidate.realtime_stream_id
                    AND predecessor.realtime_stream_ordinal < candidate.realtime_stream_ordinal
                    AND predecessor.status <> 'PUBLISHED'
                )
              )
            ORDER BY candidate.created_at ASC, candidate.id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          `,
          [OUTBOX_AGGREGATE_TYPE, OUTBOX_EVENT_TYPE]
        );
        const row = rows[0];
        if (!row) {
          commitAttempted = true;
          await client.query("COMMIT");
          transactionOpen = false;
          return published;
        }
        outboxId = row.id;
        const envelope = parseOutboxEnvelope(row.payload);
        let streamOrdinal: bigint | null = null;
        try {
          streamOrdinal = row.realtime_stream_ordinal === null ? null : BigInt(row.realtime_stream_ordinal);
        } catch {
          streamOrdinal = null;
        }
        const streamCoherent = Boolean(
          envelope
          && row.realtime_stream_id === envelope.input.streamId
          && streamOrdinal !== null
          && streamOrdinal > 0n
        );
        if (!envelope || !streamCoherent) {
          const reason = envelope ? "REALTIME_OUTBOX_STREAM_MISMATCH" : "INVALID_REALTIME_ENVELOPE";
          await quarantineOutboxAndForceResync(client, row, reason);
          commitAttempted = true;
          await client.query("COMMIT");
          transactionOpen = false;
          controlPlaneMetrics.outboxFailures += 1;
          console.error(JSON.stringify({
            type: "realtime_outbox_quarantined",
            error: reason,
          }));
          continue;
        }
        const deduplicationKey = envelope.input.deduplicationKey?.trim() || envelope.eventId;
        const { inserted } = await insertEventInTransaction(
          client,
          envelope.input,
          envelope.eventId,
          deduplicationKey
        );
        await client.query(
          `
            UPDATE public.erp_outbox_events
            SET status = 'PUBLISHED',
                attempt_count = attempt_count + 1,
                published_at = COALESCE(published_at, now()),
                last_error = NULL
            WHERE id = $1::uuid
          `,
          [row.id]
        );
        if (inserted) {
          await client.query("SELECT pg_notify($1, $2)", [CONTROL_CHANNEL, JSON.stringify({ kind: "event" })]);
        }
        commitAttempted = true;
        await client.query("COMMIT");
        transactionOpen = false;
        published += 1;
      } catch (error) {
        if (commitAttempted) {
          // The outbox row and event can already be durable. The external
          // status reconciliation below is guarded by status <> PUBLISHED,
          // and a later retry uses the same event id/key.
          destroyConnection = true;
        } else if (transactionOpen) {
          try {
            await client.query("ROLLBACK");
            transactionOpen = false;
          } catch {
            destroyConnection = true;
          }
        } else {
          destroyConnection = true;
        }
        controlPlaneMetrics.outboxFailures += 1;
        if (outboxId) {
          await pool.query(
            `
              UPDATE public.erp_outbox_events
              SET status = 'FAILED',
                  attempt_count = attempt_count + 1,
                  available_at = now() + interval '5 seconds',
                  last_error = $2
              WHERE id = $1::uuid
                AND status <> 'PUBLISHED'
            `,
            [outboxId, privacySafeErrorName(error)]
          ).catch(() => undefined);
        }
        throw error;
      } finally {
        client.release(destroyConnection);
      }
    }
    return published;
  }

  async revokeSessions(userId: number): Promise<number> {
    const client = await pool.connect();
    const mutation = await withRealtimeOutboxTransaction(client, async (tx) => ({
      userId,
      epoch: await bumpRealtimeSessionEpoch(tx, userId),
    }), {
      reconcileCommit: async (verifier, result) => {
        const { rows } = await verifier.query<{ session_epoch: string }>(
          "SELECT COALESCE((SELECT session_epoch FROM public.realtime_session_epochs WHERE user_id = $1), 0)::text AS session_epoch",
          [result.userId]
        );
        const visible = Number.parseInt(rows[0]?.session_epoch ?? "0", 10);
        if (visible >= result.epoch) return "committed";
        if (visible < result.epoch) return "not_committed";
        return "unknown";
      },
    });
    return mutation.epoch;
  }

  async subscribe(listener: (signal: RealtimeControlSignal) => void): Promise<() => Promise<void>> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL_MISSING");
    let activeClient: Client | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let reconnectAttempt = 0;
    let stopped = false;

    const handleNotification = (message: { channel: string; payload?: string }) => {
      if (message.channel !== CONTROL_CHANNEL || typeof message.payload !== "string") return;
      try {
        const parsed = JSON.parse(message.payload) as unknown;
        if (!isRecord(parsed) || typeof parsed.kind !== "string") return;
        if (parsed.kind === "event") listener({ kind: "event" });
        if (parsed.kind === "authorization_changed") listener({ kind: "authorization_changed" });
        if (parsed.kind === "session_revoked" && Number.isSafeInteger(parsed.userId) && Number(parsed.userId) > 0) {
          listener({ kind: "session_revoked", userId: Number(parsed.userId) });
        }
        if (parsed.kind === "presence_changed" && Number.isSafeInteger(parsed.userId) && Number(parsed.userId) > 0 && typeof parsed.online === "boolean") {
          listener({ kind: "presence_changed", userId: Number(parsed.userId), online: parsed.online });
        }
        if (parsed.kind === "full_resync_required") listener({ kind: "full_resync_required" });
      } catch {
        controlPlaneMetrics.listenerErrors += 1;
      }
    };

    const openClient = async (initial: boolean): Promise<void> => {
      if (stopped) return;
      const client = new Client({ connectionString });
      let reconnectScheduled = false;
      const scheduleReconnect = (error: unknown) => {
        if (stopped || reconnectScheduled || activeClient !== client) return;
        reconnectScheduled = true;
        activeClient = null;
        controlPlaneMetrics.listenerErrors += 1;
        console.error(JSON.stringify({
          type: "realtime_control_listener_error",
          error: privacySafeErrorName(error),
        }));
        void client.end().catch(() => undefined);
        const delayMs = Math.min(30_000, 250 * (2 ** Math.min(reconnectAttempt, 7)));
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void openClient(false).catch((reconnectError) => scheduleReconnect(reconnectError));
        }, delayMs);
        reconnectTimer.unref?.();
      };
      client.on("notification", handleNotification);
      client.on("error", scheduleReconnect);
      client.on("end", () => scheduleReconnect(new Error("REALTIME_CONTROL_LISTENER_ENDED")));
      activeClient = client;
      try {
        await client.connect();
        await client.query(`LISTEN ${CONTROL_CHANNEL}`);
        if (!initial) controlPlaneMetrics.listenerReconnects += 1;
        reconnectAttempt = 0;
      } catch (error) {
        if (initial) {
          if (activeClient === client) activeClient = null;
          await client.end().catch(() => undefined);
          throw error;
        }
        scheduleReconnect(error);
      }
    };

    await openClient(true);
    return async () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const client = activeClient;
      activeClient = null;
      if (client) {
        await client.query(`UNLISTEN ${CONTROL_CHANNEL}`).catch(() => undefined);
        await client.end().catch(() => undefined);
      }
    };
  }

  async pruneExpired(): Promise<number> {
    const client = await pool.connect();
    const mutation = await withRealtimeOutboxTransaction(client, async (tx) => {
      const { rows } = await tx.query<{ pruned_through: string | null; deleted_count: string }>(
        `
          WITH expired AS (
            SELECT sequence
            FROM public.realtime_event_log
            WHERE expires_at <= now()
            ORDER BY sequence
            LIMIT 1000
            FOR UPDATE SKIP LOCKED
          ), deleted AS (
            DELETE FROM public.realtime_event_log event
            USING expired
            WHERE event.sequence = expired.sequence
            RETURNING event.sequence
          )
          SELECT MAX(sequence)::text AS pruned_through, COUNT(*)::text AS deleted_count
          FROM deleted
        `
      );
      const prunedThrough = rows[0]?.pruned_through;
      if (prunedThrough) {
        await tx.query(
          `
            UPDATE public.realtime_event_sequence_state
            SET pruned_through = GREATEST(pruned_through, $1::bigint)
            WHERE singleton = true
          `,
          [prunedThrough]
        );
      }
      return {
        deletedCount: Number.parseInt(rows[0]?.deleted_count ?? "0", 10),
        prunedThrough: prunedThrough ? BigInt(prunedThrough) : null,
      };
    }, {
      reconcileCommit: async (verifier, result) => {
        if (result.prunedThrough === null) return "committed";
        const { rows } = await verifier.query<{ pruned_through: string }>(
          "SELECT pruned_through::text FROM public.realtime_event_sequence_state WHERE singleton = true"
        );
        const visible = BigInt(rows[0]?.pruned_through ?? "0");
        return visible >= result.prunedThrough ? "committed" : "not_committed";
      },
    });
    return mutation.deletedCount;
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
