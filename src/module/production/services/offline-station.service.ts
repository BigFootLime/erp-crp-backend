import { HttpError } from "../../../utils/httpError";
import { fingerprintPayload } from "../domain/production-execution";
import type { StationContext } from "../middlewares/station-authorization.middleware";
import type { AuditContext } from "../repository/production.repository";
import { repoStationAudit } from "../repository/station.repository";
import {
  repoCanonicalIdempotencyExists,
  repoCompleteOfflineEvent,
  repoOfflineDependency,
  repoOfflineSyncEnabled,
  repoPurgeOfflineEvents,
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

function assertIdentity(station: StationContext, event: OfflineStationEventDTO): void {
  if (event.device_id !== station.device_id) {
    throw new HttpError(409, "OFFLINE_DEVICE_CONFLICT", "L'appareil de l'événement ne correspond plus à la session active.");
  }
  if (event.user_id !== station.user.id) {
    throw new HttpError(409, "OFFLINE_OPERATOR_CONFLICT", "L'opérateur doit se réauthentifier avant la synchronisation.");
  }
  if (event.station_session_id !== station.session_id) {
    throw new HttpError(409, "OFFLINE_SESSION_CONFLICT", "La session d'origine n'est plus la session active.");
  }
  if (event.machine_id !== station.machine_id) {
    throw new HttpError(409, "OFFLINE_MACHINE_CONFLICT", "La machine confirmée a changé depuis la capture hors ligne.");
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
  startEventId: string | null | undefined
): Promise<string | null> {
  if (directId) return directId;
  if (!startEventId) return null;
  const dependency = await repoOfflineDependency(startEventId);
  if (!dependency) {
    throw new HttpError(409, "OFFLINE_DEPENDENCY_MISSING", "Le démarrage référencé n'a pas été synchronisé.");
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
}): Promise<string> {
  const actor = { id: params.station.user.id, role: params.station.user.role };
  const { event } = params;
  if (event.type === "POINTAGE_START") {
    const result = await svcStartExecution({
      actor,
      idempotencyKey: event.idempotency_key,
      audit: params.audit,
      stationSessionId: params.station.session_id,
      source: "OFFLINE_STATION",
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
    const pointageId = await referencedPointage(event.payload.pointage_id, event.payload.start_event_id);
    if (!pointageId) throw new HttpError(409, "OFFLINE_POINTAGE_REQUIRED", "Pointage à arrêter introuvable.");
    const result = await svcStopExecution({
      actor,
      id: pointageId,
      idempotencyKey: event.idempotency_key,
      audit: params.audit,
      body: {
        comment: event.payload.comment,
        end_ts: event.occurred_at,
        retroactive_reason: OFFLINE_REASON,
      },
    });
    return result.id;
  }

  const pointageId = await referencedPointage(event.payload.pointage_id, event.payload.pointage_start_event_id);
  const { pointage_start_event_id: _dependencyId, ...quantityBody } = event.payload;
  const result = await svcDeclareQuantity({
    actor,
    idempotencyKey: event.idempotency_key,
    audit: params.audit,
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
  const requestHash = fingerprintPayload("production.station.offline.v1", params.event);
  let drift: number;
  try {
    assertIdentity(params.station, params.event);
    drift = assertClock(params.event, params.nowMs);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status >= 500) throw error;
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
    return rejection(params.event.event_id, error.code, error.message.slice(0, 500));
  }
  const reservation = await repoReserveOfflineEvent({
    batchId: params.batchId,
    event: params.event,
    requestHash,
    clockDriftSeconds: drift,
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
  if (reservation.outcome.status === "SYNCED") {
    return {
      event_id: params.event.event_id,
      status: "SYNCED",
      server_entity_id: reservation.outcome.server_entity_id ?? undefined,
      replayed: true,
    };
  }
  if (reservation.outcome.status === "REJECTED") {
    return rejection(
      params.event.event_id,
      reservation.outcome.error_code ?? "OFFLINE_REJECTED",
      reservation.outcome.error_message ?? "Événement refusé.",
      true
    );
  }

  try {
    const canonicalReplay = await repoCanonicalIdempotencyExists(params.event.idempotency_key);
    const entityId = await applyCanonicalEvent(params);
    await repoCompleteOfflineEvent({
      eventId: params.event.event_id,
      requestHash,
      status: "SYNCED",
      serverEntityId: entityId,
      resultPayload: { server_entity_id: entityId },
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
    await repoCompleteOfflineEvent({
      eventId: params.event.event_id,
      requestHash,
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
  for (const event of params.body.events) {
    results.push(await processEvent({
      batchId: params.body.client_batch_id,
      event,
      station: params.station,
      audit: params.audit,
      nowMs: serverTime.getTime(),
    }));
  }

  const retentionDays = boundedEnv("STATION_OFFLINE_RECEIPT_RETENTION_DAYS", 30, 7, 365);
  void repoPurgeOfflineEvents(retentionDays).catch(() => undefined);
  return { server_time: serverTime.toISOString(), kill_switch_enabled: false, results };
}
