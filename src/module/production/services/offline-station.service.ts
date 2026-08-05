import { createHash, randomUUID } from "node:crypto";

import { HttpError } from "../../../utils/httpError";
import { fingerprintPayload } from "../domain/production-execution";
import type { StationContext } from "../middlewares/station-authorization.middleware";
import type { AuditContext } from "../repository/production.repository";
import type { ProductionExecutionTransactionHooks } from "../repository/production-execution.repository";
import { repoStationAudit } from "../repository/station.repository";
import {
  repoCanonicalIdempotencyExists,
  repoAssertOfflineEventClaim,
  repoCompleteOfflineEvent,
  repoOfflineDependency,
  repoOfflineSourceSession,
  repoOfflineSyncEnabled,
  repoPurgeOfflineEvents,
  repoReleaseOfflineEventClaim,
  repoReserveOfflineEvent,
} from "../repository/offline-station.repository";
import {
  svcDeclareQuantity,
  svcStartExecution,
  svcStopExecution,
} from "./production-execution.service";
import type {
  OfflineStationEventDTO,
  OfflineStationSyncDTO,
} from "../validators/offline-station.validators";

const OFFLINE_REASON = "Synchronisation différée depuis une station hors ligne.";
const OFFLINE_EXECUTION_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
const SOURCE_SESSION_CLOCK_TOLERANCE_MS = 60_000;
const RETRYABLE_DEPENDENCY_CODES = new Set(["OFFLINE_DEPENDENCY_MISSING", "OFFLINE_DEPENDENCY_PENDING"]);

export type OfflineSyncResult = {
  event_id: string;
  status: "SYNCED" | "REJECTED";
  code?: string;
  message?: string;
  server_entity_id?: string;
  replayed: boolean;
};

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function envKillSwitchEnabled(): boolean {
  return /^(?:0|false|off|disabled)$/i.test(process.env.STATION_OFFLINE_SYNC_ENABLED?.trim() ?? "");
}

function rejection(eventId: string, code: string, message: string, replayed = false): OfflineSyncResult {
  return { event_id: eventId, status: "REJECTED", code, message, replayed };
}

function executionSessionIdForStartEvent(startEventId: string): string {
  const bytes = createHash("sha1")
    .update(OFFLINE_EXECUTION_NAMESPACE)
    .update(`cerp:offline-execution:${startEventId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function executionSessionId(event: OfflineStationEventDTO): string | null {
  if (event.type === "POINTAGE_START") return executionSessionIdForStartEvent(event.event_id);
  return event.payload.start_event_id
    ? executionSessionIdForStartEvent(event.payload.start_event_id)
    : null;
}

async function assertIdentity(station: StationContext, event: OfflineStationEventDTO): Promise<void> {
  if (event.device_id !== station.device_id) {
    throw new HttpError(409, "OFFLINE_DEVICE_CONFLICT", "L'appareil de l'événement ne correspond plus à la session active.");
  }
  if (event.user_id !== station.user.id) {
    throw new HttpError(409, "OFFLINE_OPERATOR_CONFLICT", "L'opérateur doit se réauthentifier avant la synchronisation.");
  }
  if (event.station_session_id === station.session_id && event.machine_id !== station.machine_id) {
    throw new HttpError(409, "OFFLINE_MACHINE_CONFLICT", "La machine confirmée a changé depuis la capture hors ligne.");
  }

  const source = await repoOfflineSourceSession(event.station_session_id);
  if (!source
      || source.device_id !== event.device_id
      || source.user_id !== event.user_id
      || source.machine_id !== event.machine_id) {
    throw new HttpError(
      409,
      "OFFLINE_SOURCE_SESSION_CONFLICT",
      "La session d'origine ne correspond pas à l'opérateur, l'appareil et la machine authentifiés."
    );
  }

  const occurredAt = Date.parse(event.occurred_at);
  const startedAt = Date.parse(source.started_at);
  const endedAt = Date.parse(source.closed_at ?? source.expires_at);
  if (
    occurredAt < startedAt - SOURCE_SESSION_CLOCK_TOLERANCE_MS
    || occurredAt > endedAt + SOURCE_SESSION_CLOCK_TOLERANCE_MS
  ) {
    throw new HttpError(
      409,
      "OFFLINE_SOURCE_SESSION_TIME_CONFLICT",
      "L'événement est hors de la période prouvée par sa session d'origine."
    );
  }
}

function clockDriftSeconds(event: OfflineStationEventDTO, nowMs: number): number {
  return Math.trunc((Date.parse(event.occurred_at) - nowMs) / 1000);
}

function assertClock(event: OfflineStationEventDTO, nowMs: number): number {
  const drift = clockDriftSeconds(event, nowMs);
  const maxAge = boundedEnv("STATION_OFFLINE_MAX_EVENT_AGE_SECONDS", 86_400, 300, 604_800);
  const maxFuture = boundedEnv("STATION_OFFLINE_MAX_FUTURE_SKEW_SECONDS", 60, 0, 60);
  if (drift > maxFuture) {
    throw new HttpError(409, "OFFLINE_CLOCK_AHEAD", "L'horloge de la station est trop en avance; l'événement doit être vérifié.");
  }
  if (drift < -maxAge) {
    throw new HttpError(409, "OFFLINE_EVENT_EXPIRED", "L'événement hors ligne dépasse la fenêtre de reprise autorisée.");
  }
  return drift;
}

async function referencedPointage(
  directId: string | null | undefined,
  startEventId: string | null | undefined,
  batchId: string,
  event: OfflineStationEventDTO,
  expectedExecutionSessionId: string | null
): Promise<string | null> {
  if (directId) return directId;
  if (!startEventId) return null;
  const dependency = await repoOfflineDependency(startEventId);
  if (!dependency) {
    throw new HttpError(409, "OFFLINE_DEPENDENCY_MISSING", "Le démarrage référencé n'a pas été synchronisé.");
  }
  if (dependency.event_type !== "POINTAGE_START") {
    throw new HttpError(409, "OFFLINE_DEPENDENCY_TYPE_INVALID", "La dépendance référencée n'est pas un démarrage.");
  }
  if (dependency.client_batch_id !== batchId
      || dependency.device_id !== event.device_id
      || dependency.operator_user_id !== event.user_id
      || dependency.station_session_id !== event.station_session_id
      || dependency.machine_id !== event.machine_id
      || !expectedExecutionSessionId
      || dependency.execution_session_id !== expectedExecutionSessionId) {
    throw new HttpError(
      409,
      "OFFLINE_DEPENDENCY_CONTEXT_CONFLICT",
      "Le démarrage référencé n'appartient pas au même lot et au même contexte opérateur."
    );
  }
  if (dependency.status !== "SYNCED" || !dependency.server_entity_id) {
    throw new HttpError(
      409,
      dependency.status === "REJECTED" ? "OFFLINE_DEPENDENCY_REJECTED" : "OFFLINE_DEPENDENCY_PENDING",
      "Le démarrage référencé n'est pas utilisable; aucun conflit n'a été écrasé."
    );
  }
  return dependency.server_entity_id;
}

async function applyCanonicalEvent(params: {
  event: OfflineStationEventDTO;
  station: StationContext;
  audit: AuditContext;
  batchId: string;
  executionSessionId: string | null;
  transactionHooks: ProductionExecutionTransactionHooks<{ id: string }>;
}): Promise<string> {
  const actor = { id: params.station.user.id, role: params.station.user.role };
  const { event } = params;
  if (event.type === "POINTAGE_START") {
    if (!params.executionSessionId) throw new Error("Offline START execution session is missing");
    const result = await svcStartExecution({
      actor,
      idempotencyKey: event.idempotency_key,
      audit: params.audit,
      executionSessionId: params.executionSessionId,
      source: "OFFLINE_STATION",
      transactionHooks: params.transactionHooks,
      body: {
        ...event.payload,
        machine_id: event.machine_id,
        start_ts: event.occurred_at,
        retroactive_reason: OFFLINE_REASON,
      },
    });
    return result.id;
  }
  if (event.type === "POINTAGE_STOP") {
    const pointageId = await referencedPointage(
      event.payload.pointage_id,
      event.payload.start_event_id,
      params.batchId,
      event,
      params.executionSessionId
    );
    if (!pointageId) throw new HttpError(409, "OFFLINE_POINTAGE_REQUIRED", "Pointage à arrêter introuvable.");
    const result = await svcStopExecution({
      actor,
      id: pointageId,
      idempotencyKey: event.idempotency_key,
      audit: params.audit,
      transactionHooks: params.transactionHooks,
      body: {
        comment: event.payload.comment,
        end_ts: event.occurred_at,
        retroactive_reason: OFFLINE_REASON,
      },
    });
    return result.id;
  }

  const pointageId = await referencedPointage(
    event.payload.pointage_id,
    event.payload.start_event_id,
    params.batchId,
    event,
    params.executionSessionId
  );
  if (!pointageId) {
    throw new HttpError(
      409,
      "OFFLINE_POINTAGE_REQUIRED",
      "Une quantité hors ligne doit référencer son pointage de production."
    );
  }
  const { start_event_id: _dependencyId, ...quantityBody } = event.payload;
  const result = await svcDeclareQuantity({
    actor,
    idempotencyKey: event.idempotency_key,
    audit: params.audit,
    sourceContext: {
      operatorUserId: event.user_id,
      machineId: event.machine_id,
      executionSessionId: params.executionSessionId,
    },
    transactionHooks: params.transactionHooks,
    body: { ...quantityBody, pointage_id: pointageId },
  });
  return result.id;
}

async function processEvent(params: {
  batchId: string;
  event: OfflineStationEventDTO;
  station: StationContext;
  audit: AuditContext;
  nowMs: number;
}): Promise<OfflineSyncResult> {
  const requestHash = fingerprintPayload("production.station.offline.v1", {
    client_batch_id: params.batchId,
    event: params.event,
  });
  const drift = clockDriftSeconds(params.event, params.nowMs);
  const stableExecutionSessionId = executionSessionId(params.event);
  const claimToken = randomUUID();
  const reservation = await repoReserveOfflineEvent({
    batchId: params.batchId,
    event: params.event,
    requestHash,
    clockDriftSeconds: drift,
    executionSessionId: stableExecutionSessionId,
    claimToken,
    authenticatedDeviceId: params.station.device_id,
    authenticatedOperatorUserId: params.station.user.id,
    authenticatedStationSessionId: params.station.session_id,
    authenticatedMachineId: params.station.machine_id,
  });
  if (reservation.kind === "CONFLICT") {
    await repoStationAudit({
      event_type: "OFFLINE_EVENT_REJECTED",
      outcome: "DENIED",
      reason_code: "OFFLINE_IDEMPOTENCY_CONFLICT",
      device_id: params.station.device_id,
      session_id: params.station.session_id,
      user_id: params.station.user.id,
      machine_id: params.station.machine_id,
      detail: { event_id: params.event.event_id, event_type: params.event.type },
    });
    return rejection(params.event.event_id, "OFFLINE_IDEMPOTENCY_CONFLICT", "L'identifiant a déjà servi à un événement différent.");
  }
  if (reservation.kind === "BUSY") {
    throw new HttpError(503, "OFFLINE_EVENT_IN_PROGRESS", "Une synchronisation identique est déjà en cours; réessayez sans modifier l'événement.");
  }
  if (reservation.outcome.status === "REJECTED") {
    return rejection(
      params.event.event_id,
      reservation.outcome.error_code ?? "OFFLINE_REJECTED",
      reservation.outcome.error_message ?? "Événement refusé.",
      true
    );
  }
  if (reservation.outcome.status === "SYNCED") {
    return {
      event_id: params.event.event_id,
      status: "SYNCED",
      server_entity_id: reservation.outcome.server_entity_id ?? undefined,
      replayed: true,
    };
  }

  try {
    await assertIdentity(params.station, params.event);
    assertClock(params.event, params.nowMs);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status >= 500) throw error;
    const message = error.message.slice(0, 500);
    await repoCompleteOfflineEvent({
      eventId: params.event.event_id,
      requestHash,
      claimToken,
      status: "REJECTED",
      errorCode: error.code,
      errorMessage: message,
    });
    await repoStationAudit({
      event_type: "OFFLINE_EVENT_REJECTED",
      outcome: "DENIED",
      reason_code: error.code,
      device_id: params.station.device_id,
      session_id: params.station.session_id,
      user_id: params.station.user.id,
      machine_id: params.station.machine_id,
      detail: { event_id: params.event.event_id, event_type: params.event.type },
    });
    return rejection(params.event.event_id, error.code, message);
  }

  const transactionHooks: ProductionExecutionTransactionHooks<{ id: string }> = {
    beforeEffect: (tx) => repoAssertOfflineEventClaim(tx, {
      eventId: params.event.event_id,
      requestHash,
      claimToken,
    }),
    beforeCommit: (tx, result) => repoCompleteOfflineEvent({
      eventId: params.event.event_id,
      requestHash,
      claimToken,
      status: "SYNCED",
      serverEntityId: result.id,
      resultPayload: {
        server_entity_id: result.id,
        execution_session_id: stableExecutionSessionId,
      },
    }, tx),
  };

  try {
    const canonicalReplay = await repoCanonicalIdempotencyExists(params.event.idempotency_key);
    const entityId = await applyCanonicalEvent({
      ...params,
      executionSessionId: stableExecutionSessionId,
      transactionHooks,
    });
    await repoStationAudit({
      event_type: "OFFLINE_EVENT_SYNCED",
      device_id: params.station.device_id,
      session_id: params.station.session_id,
      user_id: params.station.user.id,
      machine_id: params.station.machine_id,
      detail: { event_id: params.event.event_id, event_type: params.event.type, clock_drift_seconds: drift },
    });
    return {
      event_id: params.event.event_id,
      status: "SYNCED",
      server_entity_id: entityId,
      replayed: reservation.existing || canonicalReplay,
    };
  } catch (error) {
    if (!(error instanceof HttpError) || error.status >= 500) throw error;
    const message = error.message.slice(0, 500);
    if (RETRYABLE_DEPENDENCY_CODES.has(error.code)) {
      await repoReleaseOfflineEventClaim({
        eventId: params.event.event_id,
        requestHash,
        claimToken,
      });
      throw new HttpError(503, error.code, message);
    }
    await repoCompleteOfflineEvent({
      eventId: params.event.event_id,
      requestHash,
      claimToken,
      status: "REJECTED",
      errorCode: error.code,
      errorMessage: message,
    });
    await repoStationAudit({
      event_type: "OFFLINE_EVENT_REJECTED",
      outcome: "DENIED",
      reason_code: error.code,
      device_id: params.station.device_id,
      session_id: params.station.session_id,
      user_id: params.station.user.id,
      machine_id: params.station.machine_id,
      detail: { event_id: params.event.event_id, event_type: params.event.type },
    });
    return rejection(params.event.event_id, error.code, message);
  }
}

export async function svcSyncOfflineStation(params: {
  body: OfflineStationSyncDTO;
  station: StationContext;
  audit: AuditContext;
}) {
  const serverTime = new Date();
  const enabled = !envKillSwitchEnabled() && await repoOfflineSyncEnabled();
  if (!enabled) {
    return { server_time: serverTime.toISOString(), kill_switch_enabled: true, results: [] as OfflineSyncResult[] };
  }

  const results: OfflineSyncResult[] = [];
  let retryableError: HttpError | null = null;
  for (const event of params.body.events) {
    try {
      results.push(await processEvent({
        batchId: params.body.client_batch_id,
        event,
        station: params.station,
        audit: params.audit,
        nowMs: serverTime.getTime(),
      }));
    } catch (error) {
      if (error instanceof HttpError && error.status === 503) {
        retryableError ??= error;
        continue;
      }
      throw error;
    }
  }
  if (retryableError) throw retryableError;

  const retentionDays = boundedEnv("STATION_OFFLINE_RECEIPT_RETENTION_DAYS", 30, 7, 365);
  void repoPurgeOfflineEvents(retentionDays).catch(() => undefined);
  return { server_time: serverTime.toISOString(), kill_switch_enabled: false, results };
}
