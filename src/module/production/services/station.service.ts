// Service du poste opérateur tablette (#159).
//
// Il ORCHESTRE : il applique les politiques pures du domaine, appelle le
// repository, et compose les read models. Il ne contient ni SQL, ni règle
// métier inédite.
//
// CE QU'IL NE FAIT JAMAIS — et qui est vérifié par test :
//   * démarrer, mettre en pause ou terminer un segment d'exécution : c'est le
//     rôle exclusif de `production-execution.service.ts` (#274) ;
//   * écrire une présence, une pause ou une paie (#119) ;
//   * créer un mouvement de stock, un lot, une réception, un BL ou une facture ;
//   * envoyer quoi que ce soit vers une commande numérique.

import { HttpError } from "../../../utils/httpError";
import { evaluateInstrumentUsage, type InstrumentState } from "../../qualite/domain/quality-release";

import {
  assertDeviceUsable,
  assertHandoverAcknowledgeable,
  assertHandoverParties,
  assertOperatorSwitchDecided,
  assertOwnSessionOrSupervision,
  assessOperationReadiness,
  BADGE_LOCK_SECONDS,
  BADGE_MAX_FAILED_ATTEMPTS,
  compareWorklistEntries,
  evaluateMachineSelectability,
  listStationCapabilities,
  resolvePlanForSnapshot,
  roleHasStationCapability,
  stripCostFields,
  WORKLIST_ORDERING_EXPLANATION,
  type IdentificationMethod,
  type NextBusinessAction,
  type OperatorSwitchDecision,
  type PlanDocumentRef,
} from "../domain/station";
import {
  repoAcknowledgeHandover,
  repoActiveExecutionForUser,
  repoConfirmSessionMachine,
  repoCreateHandover,
  repoDossier,
  repoEnrollDevice,
  repoFindDeviceByCode,
  repoFindDeviceById,
  repoGetHandover,
  repoIssueCredential,
  repoListCredentials,
  repoListDevices,
  repoListHandoversForUser,
  repoListSelectableMachines,
  repoListStationAudit,
  repoOpenSession,
  repoRegisterCredentialFailure,
  repoRegisterCredentialSuccess,
  repoResolveCredential,
  repoResolveScan,
  repoRevokeCredential,
  repoRevokeDevice,
  repoSetSessionState,
  repoStationAudit,
  repoTouchDeviceSeen,
  repoUpdateDevice,
  repoUserRealtimeScope,
  repoWorklist,
  type DeviceRow,
} from "../repository/station.repository";
import type { StationContext } from "../middlewares/station-authorization.middleware";
import type {
  EnrollDeviceDTO,
  IssueCredentialDTO,
  ListDevicesQueryDTO,
  StationAuditQueryDTO,
  StationBootstrapQueryDTO,
  StationCloseDTO,
  StationConfirmMachineDTO,
  StationHandoverDTO,
  StationHeartbeatDTO,
  StationIdentifyDTO,
  StationLockDTO,
  StationScanDTO,
  StationUnlockDTO,
  StationWorklistQueryDTO,
  UpdateDeviceDTO,
} from "../validators/station.validators";

export type Actor = { id: number; role: string | null };

/**
 * Chemin de téléchargement d'un document de pièce technique.
 *
 * Il pointe vers la route EXISTANTE du module Pièces techniques, qui applique
 * ses propres contrôles d'accès. Le poste ne réimplémente pas la distribution
 * de fichiers et n'expose jamais de chemin disque.
 */
function documentDownloadPath(pieceTechniqueId: string | null | undefined, documentId: string): string | null {
  if (!pieceTechniqueId) return null;
  return `/pieces-techniques/${pieceTechniqueId}/documents/${documentId}/file`;
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Un seul appel pour tout ce dont l'écran a besoin au démarrage : appareil,
 * session, utilisateur, machine, capacités, exécution en cours, heure serveur.
 *
 * Sans session, la réponse décrit l'écran VERROUILLÉ — c'est un état normal,
 * pas une erreur : une tablette au repos doit afficher quelque chose d'utile.
 */
export async function svcBootstrap(params: {
  query: StationBootstrapQueryDTO;
  station: StationContext | undefined;
  jwtActor: Actor | null;
}): Promise<Record<string, unknown>> {
  const now = new Date();

  const device = params.station
    ? await repoFindDeviceById(params.station.device_id)
    : params.query.device_code
      ? await repoFindDeviceByCode(params.query.device_code)
      : null;

  if (params.query.device_code && !device) {
    // On distingue « tablette inconnue » de « tablette révoquée » : la consigne
    // affichée n'est pas la même.
    await repoStationAudit({
      event_type: "AUTHORIZATION_DENIED",
      outcome: "DENIED",
      reason_code: "DEVICE_UNKNOWN",
      detail: { device_code: params.query.device_code },
    });
    throw new HttpError(
      404,
      "STATION_DEVICE_UNKNOWN",
      "Cette tablette n'est pas enregistrée dans CERP. Faites-la enrôler par le chef d'atelier."
    );
  }

  if (device && device.status !== "ACTIVE") {
    throw new HttpError(
      403,
      device.status === "REVOKED" ? "STATION_DEVICE_REVOKED" : "STATION_DEVICE_DISABLED",
      device.status === "REVOKED"
        ? "Cette tablette a été révoquée."
        : "Cette tablette est désactivée. Contactez le chef d'atelier."
    );
  }

  if (device) {
    await repoTouchDeviceSeen({ device_id: device.id, app_version: params.query.app_version ?? null });
  }

  const identity = params.station?.user ?? null;
  const role = identity?.role ?? params.jwtActor?.role ?? null;

  const activeExecution = identity ? await repoActiveExecutionForUser(identity.id) : null;
  const pendingHandovers = identity
    ? await repoListHandoversForUser({ userId: identity.id, onlyPending: true, limit: 5 })
    : [];

  const machine =
    device?.assignment_mode === "FIXED"
      ? device.machine
      : params.station?.machine_id
        ? (await repoListSelectableMachines({ workshop_zone: null, limit: 1000 })).find(
            (m) => m.id === params.station?.machine_id
          ) ?? null
        : null;

  return {
    server_time: now.toISOString(),
    device: device
      ? {
          id: device.id,
          public_code: device.public_code,
          label: device.label,
          site: device.site,
          workshop_zone: device.workshop_zone,
          assignment_mode: device.assignment_mode,
          status: device.status,
          auto_lock_seconds: device.auto_lock_seconds,
          session_max_seconds: device.session_max_seconds,
          assigned_machine: device.machine,
        }
      : null,
    session: params.station
      ? {
          id: params.station.session_id,
          machine_id: params.station.machine_id,
          state: "ACTIVE",
        }
      : null,
    user: identity
      ? {
          id: identity.id,
          username: identity.username,
          display_name:
            [identity.name, identity.surname].filter(Boolean).join(" ").trim() || identity.username,
          first_name: identity.name,
          role: identity.role,
        }
      : null,
    machine: machine
      ? {
          id: machine.id,
          code: machine.code,
          name: machine.name,
          // `is_available` sur le type d'affectation fixe n'existe pas : on
          // renvoie ce qu'on sait, sans inventer.
          ...("is_available" in machine ? { is_available: machine.is_available } : {}),
        }
      : null,
    capabilities: listStationCapabilities(role),
    active_execution: activeExecution,
    pending_handovers: pendingHandovers,
    /** Modes d'identification réellement exploitables sur ce serveur. */
    identification_methods: identificationMethodsAvailable(),
    realtime_rooms: identity
      ? await buildRealtimeRooms(identity.id, params.station?.machine_id ?? null, params.station?.device_id ?? null)
      : [],
  };
}

function identificationMethodsAvailable(): IdentificationMethod[] {
  const methods: IdentificationMethod[] = ["PASSWORD"];
  // Le badge n'est proposé que si le poivre est configuré : afficher un bouton
  // qui échouera systématiquement est pire que de ne pas l'afficher.
  if ((process.env.STATION_BADGE_PEPPER ?? "").length >= 16) {
    methods.unshift("BADGE", "QR");
  }
  return methods;
}

async function buildRealtimeRooms(
  userId: number,
  machineId: string | null,
  deviceId: string | null
): Promise<string[]> {
  const rooms = [`USER:${userId}`];
  if (machineId) rooms.push(`MACHINE:${machineId}`);
  if (deviceId) rooms.push(`STATION:${deviceId}`);
  const scope = await repoUserRealtimeScope(userId);
  for (const ofId of scope.ofIds) rooms.push(`OF:${ofId}`);
  return Array.from(new Set(rooms));
}

/* -------------------------------------------------------------------------- */
/* Identification et session                                                  */
/* -------------------------------------------------------------------------- */

export async function svcIdentify(params: {
  body: StationIdentifyDTO;
  jwtActor: Actor | null;
  requestId: string | null;
}): Promise<{
  token: string;
  maxAgeSeconds: number;
  payload: Record<string, unknown>;
}> {
  const device = await repoFindDeviceByCode(params.body.device_code);
  assertDeviceUsable(device);

  let userId: number;
  let credentialId: string | null = null;

  if (params.body.method === "PASSWORD" || params.body.method === "SSO") {
    // Ces modes ne créent AUCUN nouveau facteur d'authentification : ils
    // ouvrent une session de poste pour l'utilisateur DÉJÀ authentifié par
    // l'ERP. Sans JWT valide, refus.
    if (!params.jwtActor) {
      throw new HttpError(
        401,
        "STATION_ERP_LOGIN_REQUIRED",
        "Connectez-vous d'abord à CERP, puis ouvrez la session de poste."
      );
    }
    userId = params.jwtActor.id;
  } else {
    const resolved = await repoResolveCredential(params.body.credential ?? "");
    if (!resolved.ok) {
      await repoRegisterCredentialFailure({
        credentialId: resolved.credential_id,
        maxAttempts: BADGE_MAX_FAILED_ATTEMPTS,
        lockSeconds: BADGE_LOCK_SECONDS,
      });
      await repoStationAudit({
        event_type: "IDENTIFICATION_FAILED",
        outcome: "DENIED",
        reason_code: resolved.reason,
        device_id: device.id,
        request_id: params.requestId,
      });
      // Message VOLONTAIREMENT identique dans les trois cas : distinguer
      // « badge inconnu » de « badge révoqué » offrirait un oracle
      // d'énumération à qui présente des cartes au hasard.
      throw new HttpError(
        401,
        "STATION_IDENTIFICATION_FAILED",
        resolved.reason === "LOCKED"
          ? "Trop de tentatives sur ce support. Patientez ou identifiez-vous autrement."
          : "Support non reconnu. Réessayez ou identifiez-vous autrement."
      );
    }
    userId = resolved.user_id;
    credentialId = resolved.credential_id;
  }

  // Un pointage en cours sur ce poste impose une décision métier explicite.
  const liveExecutionOnMachine = device.machine_id
    ? (await repoListSelectableMachines({ workshop_zone: null, limit: 1000 })).find(
        (m) => m.id === device.machine_id
      )
    : null;
  const busyByOther =
    !!liveExecutionOnMachine?.active_operator_user_id &&
    liveExecutionOnMachine.active_operator_user_id !== userId;

  const actorRole = params.jwtActor?.role ?? null;
  assertOperatorSwitchDecided({
    hasActiveExecution: busyByOther,
    decision: params.body.switch_decision as OperatorSwitchDecision | undefined,
    actorRole,
  });

  const machineId =
    device.assignment_mode === "FIXED" ? device.machine_id : (params.body.machine_id ?? null);

  const { session, token } = await repoOpenSession({
    device,
    user_id: userId,
    machine_id: machineId,
    identification_method: params.body.method,
    app_version: params.body.app_version ?? null,
    request_id: params.requestId,
  });

  if (credentialId) await repoRegisterCredentialSuccess(credentialId);

  return {
    token,
    maxAgeSeconds: device.session_max_seconds,
    payload: {
      session_id: session.id,
      device: { id: device.id, public_code: device.public_code, label: device.label },
      machine_id: machineId,
      expires_at: session.expires_at.toISOString(),
      auto_lock_seconds: device.auto_lock_seconds,
      /** Rappelé à chaque ouverture : le badge n'écrit rien dans le module RH. */
      notice:
        "Cette identification ouvre une session de poste. Elle ne crée aucun pointage de production et aucune donnée de présence RH.",
    },
  };
}

export async function svcLock(params: {
  station: StationContext;
  body: StationLockDTO;
}): Promise<Record<string, unknown>> {
  const session = await repoSetSessionState({ sessionId: params.station.session_id, state: "LOCKED" });
  await repoStationAudit({
    event_type: "SESSION_LOCKED",
    reason_code: params.body.reason,
    device_id: params.station.device_id,
    session_id: session.id,
    user_id: params.station.user.id,
  });

  // On DIT que rien n'a été arrêté. Un opérateur qui verrouille son écran doit
  // pouvoir le faire sans crainte.
  const active = await repoActiveExecutionForUser(params.station.user.id);
  return {
    state: session.state,
    execution_still_running: Boolean(active),
    notice: active
      ? "Écran verrouillé. Votre pointage continue : il n'a pas été arrêté."
      : "Écran verrouillé.",
  };
}

export async function svcUnlock(params: {
  device_code: string;
  body: StationUnlockDTO;
  jwtActor: Actor | null;
  sessionToken: string | null;
  requestId: string | null;
}): Promise<{ token: string; maxAgeSeconds: number; payload: Record<string, unknown> }> {
  // Déverrouiller = ré-identifier. On ne « reprend » pas une session sur la
  // simple foi d'un cookie encore présent : c'est le geste du badge qui prouve
  // que quelqu'un est bien revenu devant la tablette.
  return svcIdentify({
    body: {
      device_code: params.device_code,
      method: params.body.method,
      credential: params.body.credential,
    } as StationIdentifyDTO,
    jwtActor: params.jwtActor,
    requestId: params.requestId,
  });
}

export async function svcCloseSession(params: {
  station: StationContext;
  body: StationCloseDTO;
}): Promise<Record<string, unknown>> {
  const active = await repoActiveExecutionForUser(params.station.user.id);

  const session = await repoSetSessionState({
    sessionId: params.station.session_id,
    state: "CLOSED",
    reason: params.body.reason,
  });
  await repoStationAudit({
    event_type: "SESSION_CLOSED",
    reason_code: params.body.reason,
    device_id: params.station.device_id,
    session_id: session.id,
    user_id: params.station.user.id,
    detail: { execution_was_running: Boolean(active) },
  });

  return {
    state: session.state,
    execution_still_running: Boolean(active),
    // Fermer une session n'arrête pas un pointage : le dire évite qu'un
    // opérateur croie avoir terminé sa phase en quittant l'écran.
    notice: active
      ? "Session fermée. ATTENTION : votre pointage est toujours en cours. Arrêtez-le depuis « Mon poste » si votre travail est terminé."
      : "Session fermée.",
  };
}

export async function svcHeartbeat(params: {
  station: StationContext;
  body: StationHeartbeatDTO;
}): Promise<Record<string, unknown>> {
  const now = new Date();
  await repoTouchDeviceSeen({
    device_id: params.station.device_id,
    app_version: params.body.app_version ?? null,
  });

  // Dérive d'horloge : signalée, jamais utilisée pour un calcul métier.
  let clockDriftSeconds: number | null = null;
  if (params.body.client_time) {
    const clientTime = Date.parse(params.body.client_time);
    if (Number.isFinite(clientTime)) {
      clockDriftSeconds = Math.round((clientTime - now.getTime()) / 1000);
    }
  }

  return {
    server_time: now.toISOString(),
    session_id: params.station.session_id,
    clock_drift_seconds: clockDriftSeconds,
    clock_warning:
      clockDriftSeconds !== null && Math.abs(clockDriftSeconds) > 120
        ? "L'horloge de cette tablette est décalée de plus de deux minutes. Les durées affichées restent celles du serveur."
        : null,
    auto_lock_seconds: params.station.auto_lock_seconds,
  };
}

/* -------------------------------------------------------------------------- */
/* Machines                                                                   */
/* -------------------------------------------------------------------------- */

export async function svcListMachines(params: {
  station: StationContext;
}): Promise<Record<string, unknown>> {
  const machines = await repoListSelectableMachines({
    workshop_zone: params.station.device_zone,
    limit: 200,
  });

  const evaluated = machines.map((machine) => {
    const verdict = evaluateMachineSelectability({
      machine: { ...machine, archived_at: null },
      actorUserId: params.station.user.id,
      deviceZone: params.station.device_zone,
      enforceZone: true,
    });
    return {
      id: machine.id,
      code: machine.code,
      name: machine.name,
      workshop_zone: machine.workshop_zone,
      selectable: verdict.selectable,
      reason: verdict.reason,
      reason_code: verdict.reason_code,
      busy_by_other: verdict.busy_by_other,
      // On montre QUI occupe la machine seulement à qui a le droit de superviser.
      occupied_by: roleHasStationCapability(params.station.user.role, "supervise_stations")
        ? machine.active_operator_label
        : machine.active_operator_user_id
          ? "un autre opérateur"
          : null,
      active_of_numero: machine.active_of_numero,
      active_since: machine.active_since,
    };
  });

  return {
    assignment_mode: params.station.device_assignment_mode,
    // Une tablette fixe n'offre pas de choix : elle affiche sa machine.
    locked_to_machine: params.station.device_assignment_mode === "FIXED",
    current_machine_id: params.station.machine_id,
    machines: evaluated,
  };
}

export async function svcConfirmMachine(params: {
  station: StationContext;
  body: StationConfirmMachineDTO;
}): Promise<Record<string, unknown>> {
  if (params.station.device_assignment_mode === "FIXED") {
    throw new HttpError(
      409,
      "STATION_DEVICE_FIXED",
      "Cette tablette est affectée à une machine : elle ne peut pas en changer."
    );
  }

  const machines = await repoListSelectableMachines({
    workshop_zone: params.station.device_zone,
    limit: 200,
  });
  const machine = machines.find((m) => m.id === params.body.machine_id);
  if (!machine) {
    await repoStationAudit({
      event_type: "MACHINE_REFUSED",
      outcome: "DENIED",
      reason_code: "OUT_OF_SCOPE",
      device_id: params.station.device_id,
      session_id: params.station.session_id,
      user_id: params.station.user.id,
      machine_id: params.body.machine_id,
    });
    throw new HttpError(
      403,
      "STATION_MACHINE_NOT_ALLOWED",
      "Cette machine n'est pas accessible depuis ce poste."
    );
  }

  const verdict = evaluateMachineSelectability({
    machine: { ...machine, archived_at: null },
    actorUserId: params.station.user.id,
    deviceZone: params.station.device_zone,
    enforceZone: true,
  });

  if (!verdict.selectable) {
    // Une machine occupée n'est jamais prise de force : reprendre exige une
    // décision explicite ET la capacité de supervision.
    if (verdict.busy_by_other && params.body.switch_decision === "SUPERVISOR_OVERRIDE") {
      assertOperatorSwitchDecided({
        hasActiveExecution: true,
        decision: "SUPERVISOR_OVERRIDE",
        actorRole: params.station.user.role,
      });
    } else {
      await repoStationAudit({
        event_type: "MACHINE_REFUSED",
        outcome: "DENIED",
        reason_code: verdict.reason_code,
        device_id: params.station.device_id,
        session_id: params.station.session_id,
        user_id: params.station.user.id,
        machine_id: machine.id,
      });
      throw new HttpError(409, `STATION_${verdict.reason_code}`, verdict.reason, {
        machine: { id: machine.id, code: machine.code, name: machine.name },
        active_of_numero: machine.active_of_numero,
      });
    }
  }

  const session = await repoConfirmSessionMachine({
    sessionId: params.station.session_id,
    machineId: machine.id,
  });
  await repoStationAudit({
    event_type: "MACHINE_CONFIRMED",
    device_id: params.station.device_id,
    session_id: session.id,
    user_id: params.station.user.id,
    machine_id: machine.id,
  });

  return {
    machine: { id: machine.id, code: machine.code, name: machine.name },
    session_id: session.id,
  };
}

/* -------------------------------------------------------------------------- */
/* File de travail                                                            */
/* -------------------------------------------------------------------------- */

export async function svcWorklist(params: {
  station: StationContext;
  query: StationWorklistQueryDTO;
}): Promise<Record<string, unknown>> {
  const rows = await repoWorklist({
    userId: params.station.user.id,
    machineId: params.station.machine_id,
    workshopZone: params.station.device_zone,
    q: params.query.q ?? null,
    machineOnly: params.query.machine_only && Boolean(params.station.machine_id),
    includeBlocked: params.query.include_blocked,
    limit: params.query.limit,
  });

  const canViewCosts = roleHasStationCapability(params.station.user.role, "view_costs");

  const items = rows.map((row) => {
    const remaining = row.quantite_lancee - row.quantite_bonne - row.quantite_rebut;
    const readiness = assessOperationReadiness({
      of_statut: row.of_statut,
      operation_status: row.operation_status,
      has_pending_predecessor: row.has_pending_predecessor,
      has_active_execution_by_other:
        row.active_by_user_id !== null && row.active_by_user_id !== params.station.user.id,
      machine_matches: !row.machine_id || row.machine_id === params.station.machine_id,
      machine_available: row.machine_is_available,
      has_technical_snapshot: row.has_technical_snapshot,
      has_plan_document: row.has_plan_document,
      first_article_pending: row.first_article_required && !row.first_article_passed,
      qty_pending_control: row.qty_pending_control,
      remaining_quantity: remaining,
    });

    return stripCostFields(
      {
        operation_id: row.operation_id,
        phase: row.phase,
        designation: row.designation,
        operation_status: row.operation_status,
        of: {
          id: row.of_id,
          numero: row.of_numero,
          statut: row.of_statut,
          priority: row.of_priority,
          date_fin_prevue: row.date_fin_prevue,
          quantite_lancee: row.quantite_lancee,
          remaining,
        },
        piece: row.piece_code
          ? { code: row.piece_code, designation: row.piece_designation }
          : null,
        affaire: row.affaire_id ? { id: row.affaire_id, reference: row.affaire_reference } : null,
        machine: row.machine_id
          ? { id: row.machine_id, code: row.machine_code, name: row.machine_name }
          : null,
        // Le temps prévu n'est affiché QUE s'il a réellement été renseigné : un
        // « 0 h 00 » se lit comme « instantané » et détruit la confiance.
        planned_hours: row.temps_total_planned > 0 ? row.temps_total_planned : null,
        real_hours: row.temps_total_real,
        readiness: readiness.level,
        readiness_headline: readiness.headline,
        readiness_reasons: readiness.reasons,
        qty_pending_control: row.qty_pending_control,
        hierarchy: {
          parent_of_id: row.parent_of_id,
          child_count: row.child_of_count,
          child_pending: row.child_of_pending,
        },
        busy_by_other:
          row.active_by_user_id !== null && row.active_by_user_id !== params.station.user.id,
        mine: row.active_by_user_id === params.station.user.id,
      },
      canViewCosts
    );
  });

  const filtered = params.query.include_blocked
    ? items
    : items.filter((item) => item.readiness !== "BLOCKED" || item.mine);

  filtered.sort((a, b) =>
    compareWorklistEntries(
      { readiness: a.readiness, due_date: a.of.date_fin_prevue, phase: a.phase },
      { readiness: b.readiness, due_date: b.of.date_fin_prevue, phase: b.phase }
    )
  );

  const recommended = filtered.find((item) => item.readiness === "READY") ?? filtered[0] ?? null;

  return {
    server_time: new Date().toISOString(),
    machine_id: params.station.machine_id,
    /** L'ordre est EXPLIQUÉ, jamais un score opaque. */
    ordering_explanation: WORKLIST_ORDERING_EXPLANATION,
    recommended_operation_id: recommended?.operation_id ?? null,
    recommendation_reason: recommended?.readiness_headline ?? null,
    total: filtered.length,
    items: filtered,
  };
}

export async function svcScan(params: {
  station: StationContext;
  body: StationScanDTO;
}): Promise<Record<string, unknown>> {
  const resolved = await repoResolveScan(params.body.code);
  if (!resolved) {
    throw new HttpError(
      404,
      "STATION_SCAN_UNRESOLVED",
      "Code non reconnu. Vérifiez l'étiquette ou saisissez le numéro d'OF."
    );
  }
  if (!resolved.operation_id) {
    throw new HttpError(
      409,
      "STATION_SCAN_NO_OPEN_OPERATION",
      `L'OF ${resolved.of_numero} n'a aucune opération ouverte.`
    );
  }
  return resolved;
}

/* -------------------------------------------------------------------------- */
/* Dossier opérateur                                                          */
/* -------------------------------------------------------------------------- */

export async function svcDossier(params: {
  station: StationContext;
  ofId: number;
  operationId: string;
}): Promise<Record<string, unknown>> {
  const raw = await repoDossier({
    ofId: params.ofId,
    operationId: params.operationId,
    userId: params.station.user.id,
  });
  if (!raw) {
    throw new HttpError(
      404,
      "STATION_DOSSIER_UNKNOWN",
      "Cette opération d'ordre de fabrication est introuvable."
    );
  }

  const r = raw as unknown as Record<string, any>;
  const core = r.of_core ?? {};
  const piece = r.piece ?? null;
  const pieceVersion = r.piece_version ?? null;
  const canViewCosts = roleHasStationCapability(params.station.user.role, "view_costs");

  // --- Plan : le snapshot FIGÉ fait foi, jamais « la dernière version ». -----
  const documents: PlanDocumentRef[] = (r.documents ?? []).map((d: any) => ({
    id: d.id,
    label: d.label ?? null,
    original_name: d.original_name,
    mime_type: d.mime_type,
    size_bytes: Number(d.size_bytes ?? 0),
    sha256: d.sha256 ?? null,
    piece_technique_id: core.piece_technique_id,
  }));

  const planResolution = resolvePlanForSnapshot({
    snapshot: {
      piece_technique_version_id: core.piece_technique_version_id ?? null,
      snapshot_sha256: core.technical_snapshot_sha256 ?? null,
      snapshot_at: core.technical_snapshot_at ? new Date(core.technical_snapshot_at) : null,
    },
    documentsForSnapshotVersion: documents,
    latestVersionIndice: r.latest_indice ?? null,
    snapshotIndice: pieceVersion?.indice ?? null,
  });

  // --- Instruments : éligibilité décidée par le SERVEUR (#228/#229). --------
  const characteristics = (r.characteristics ?? []) as any[];
  const instruments = ((r.instruments ?? []) as any[]).map((instrument) => {
    const state: InstrumentState = {
      id: instrument.id,
      code: instrument.code ?? null,
      designation: instrument.designation ?? null,
      statut: instrument.statut ?? null,
      criticite: instrument.criticite ?? null,
      categorie: instrument.categorie_code ?? instrument.categorie ?? null,
      next_due_date: null,
      deleted: false,
    };

    // Un instrument mis en quarantaine par la Métrologie n'est jamais proposé
    // comme utilisable : la décision appartient à #229, pas au poste.
    const quarantined = Boolean(instrument.quarantine_reason) || instrument.etat === "QUARANTAINE";

    const usage = evaluateInstrumentUsage({
      characteristic: {
        key: "generic",
        requires_instrument: true,
        instrument_category: null,
      },
      instrument: state,
      at: new Date(),
      policy: { block_on_overdue_critical: true },
    });

    return {
      id: instrument.id,
      code: instrument.code,
      designation: instrument.designation,
      categorie: instrument.categorie_code ?? instrument.categorie,
      etat: instrument.etat ?? instrument.statut,
      criticite: instrument.criticite,
      unite: instrument.unite,
      plage: { min: instrument.plage_min, max: instrument.plage_max },
      resolution: instrument.resolution,
      usable: !quarantined && usage.allowed,
      usage_code: quarantined ? "INSTRUMENT_QUARANTINED" : usage.code,
      usage_message: quarantined
        ? `Instrument en quarantaine : ${instrument.quarantine_reason ?? "décision Métrologie"}.`
        : usage.message,
      last_conforme_at: instrument.last_conforme_at ?? null,
    };
  });

  const firstArticleChars = characteristics.filter((c) => c.trigger_type === "FIRST_ARTICLE");
  const controls = (r.controls ?? []) as any[];
  const firstArticlePassed = controls.some(
    (c) => c.trigger_type === "FIRST_ARTICLE" && c.verdict === "CONFORME"
  );
  const firstArticleRequired = firstArticleChars.length > 0;

  const declarations = r.declarations ?? {
    qty_good: 0,
    qty_scrap: 0,
    qty_rework: 0,
    qty_pending_control: 0,
  };

  const remaining =
    Number(core.quantite_lancee ?? 0) -
    Number(core.quantite_bonne ?? 0) -
    Number(core.quantite_rebut ?? 0);

  const nextActions: NextBusinessAction[] = [];
  if (Number(declarations.qty_pending_control ?? 0) > 0) {
    nextActions.push({
      code: "QUALITY_DECISION",
      label: "Des quantités attendent une décision Qualité.",
      owning_module: "Qualité 360 (#228)",
      actionable_here: false,
    });
  }
  if (remaining <= 0) {
    nextActions.push({
      code: "PRODUCTION_RECEIPT",
      label: "Quantité lancée couverte : la mise en stock passe par la réception de production.",
      owning_module: "Réception de production (#223)",
      actionable_here: false,
    });
  }

  await repoStationAudit({
    event_type: "DOSSIER_OPENED",
    device_id: params.station.device_id,
    session_id: params.station.session_id,
    user_id: params.station.user.id,
    of_id: params.ofId,
    operation_id: params.operationId,
  });

  return {
    server_time: new Date().toISOString(),

    identity: stripCostFields(
      {
        of: {
          id: Number(core.of_id),
          numero: core.numero,
          statut: core.statut,
          priority: core.priority,
          quantite_lancee: Number(core.quantite_lancee ?? 0),
          quantite_bonne: Number(core.quantite_bonne ?? 0),
          quantite_rebut: Number(core.quantite_rebut ?? 0),
          remaining,
          date_lancement_prevue: core.date_lancement_prevue,
          date_fin_prevue: core.date_fin_prevue,
          notes: core.notes,
        },
        operation: {
          id: core.operation_id,
          phase: Number(core.phase ?? 0),
          designation: core.operation_designation,
          status: core.operation_status,
          notes: core.operation_notes,
          planned_hours: Number(core.temps_total_planned ?? 0) > 0 ? Number(core.temps_total_planned) : null,
          real_hours: Number(core.temps_total_real ?? 0),
        },
        piece: piece
          ? {
              code: piece.code_piece,
              designation: piece.designation,
              designation_2: piece.designation_2,
              ensemble: Boolean(piece.ensemble),
            }
          : null,
        version: pieceVersion
          ? {
              indice: pieceVersion.indice,
              plan_reference: pieceVersion.plan_reference,
              matiere_prevue: pieceVersion.matiere_prevue,
              statut: pieceVersion.statut,
              date_application: pieceVersion.date_application,
            }
          : null,
        affaire: r.affaire ? { id: Number(r.affaire.id), reference: r.affaire.reference } : null,
        machine: r.machine
          ? { id: r.machine.id, code: r.machine.code, name: r.machine.name }
          : null,
        poste: r.poste ? { id: r.poste.id, code: r.poste.code, label: r.poste.label } : null,
      },
      canViewCosts
    ),

    // Le snapshot est la RÉFÉRENCE : on expose son empreinte pour qu'un litige
    // puisse être tranché sur pièce.
    snapshot: {
      piece_technique_version_id: core.piece_technique_version_id ?? null,
      sha256: core.technical_snapshot_sha256 ?? null,
      frozen_at: core.technical_snapshot_at ?? null,
      indice: pieceVersion?.indice ?? null,
      latest_indice: r.latest_indice ?? null,
      is_superseded: Boolean(
        r.latest_indice && pieceVersion?.indice && r.latest_indice !== pieceVersion.indice
      ),
    },

    plan: {
      document: planResolution.document
        ? {
            id: planResolution.document.id,
            label: planResolution.document.label,
            file_name: planResolution.document.original_name,
            mime_type: planResolution.document.mime_type,
            size_bytes: planResolution.document.size_bytes,
            sha256: planResolution.document.sha256,
            // Chemin de téléchargement CONSTRUIT PAR LE SERVEUR. Le client
            // n'assemble jamais un chemin de fichier lui-même, et la route
            // cible applique ses propres contrôles d'accès. Ce n'est pas un
            // chemin disque : `storage_path` ne sort jamais d'ici.
            download_path: documentDownloadPath(core.piece_technique_id, planResolution.document.id),
          }
        : null,
      matches_snapshot: planResolution.matches_snapshot,
      warning: planResolution.warning,
    },

    documents: (r.documents ?? []).map((d: any) => ({
      id: d.id,
      label: d.label,
      file_name: d.original_name,
      mime_type: d.mime_type,
      size_bytes: Number(d.size_bytes ?? 0),
      sha256: d.sha256,
      created_at: d.created_at,
      download_path: documentDownloadPath(core.piece_technique_id, d.id),
    })),

    instructions: {
      gamme: (r.instructions ?? []).map((i: any) =>
        stripCostFields(
          {
            phase: Number(i.phase ?? 0),
            designation: i.designation,
            designation_2: i.designation_2,
            consignes: i.consignes,
            type_operation: i.type_operation,
            tp: i.tp,
            tf_unit: i.tf_unit,
          },
          canViewCosts
        )
      ),
      dossier_documents: (r.dossier_documents ?? []).map((d: any) => ({
        id: d.id,
        slot_key: d.slot_key,
        label: d.label,
        commentaire: d.commentaire,
        document_id: d.document_id,
        file_name: d.file_name,
        mime_type: d.mime_type,
        size_bytes: d.file_size_bytes ? Number(d.file_size_bytes) : null,
      })),
    },

    material: {
      expected: pieceVersion?.matiere_prevue ?? null,
      consumptions: (r.materials ?? []).map((m: any) => ({
        id: m.id,
        article: m.article_id ? { id: m.article_id, code: m.article_code, designation: m.article_designation } : null,
        lot: m.lot_id ? { id: m.lot_id, code: m.lot_code, supplier_lot_code: m.supplier_lot_code, status: m.lot_status } : null,
        qty: Number(m.qty ?? 0),
        unit_code: m.unit_code,
        effective_at: m.effective_at,
        status: m.status,
      })),
      // Le poste LIT la consommation : il ne la crée pas. Scanner un lot ici
      // n'engendre aucun mouvement de stock.
      notice:
        "Le scan d'un lot depuis le poste ne crée aucun mouvement de stock. La consommation est déclarée par le module Stock.",
    },

    quality: {
      characteristics: characteristics.map((c) => ({
        plan_code: c.plan_code,
        plan_version: c.plan_version,
        trigger_type: c.trigger_type,
        characteristic_key: c.characteristic_key,
        label: c.label,
        characteristic_type: c.characteristic_type,
        value_kind: c.value_kind,
        unit: c.unit,
        nominal: c.nominal,
        tolerance_min: c.tolerance_min,
        tolerance_max: c.tolerance_max,
        criticality: c.criticality,
        mandatory: c.mandatory,
        requires_instrument: c.requires_instrument,
        instrument_category: c.instrument_category,
        method: c.method,
        sampling_rule: c.sampling_rule,
        sampling_value: c.sampling_value,
      })),
      controls: controls.map((c) => ({
        id: c.id,
        reference: c.reference,
        trigger_type: c.trigger_type,
        status: c.status,
        verdict: c.verdict,
        control_date: c.control_date,
        qty_controlled: c.qty_controlled,
        qty_conforming: c.qty_conforming,
      })),
      first_article: {
        required: firstArticleRequired,
        passed: firstArticlePassed,
        // C'est le PLAN DE CONTRÔLE qui décide, pas une règle universelle
        // câblée dans le poste.
        blocks_series: firstArticleRequired && !firstArticlePassed,
        message: firstArticleRequired
          ? firstArticlePassed
            ? "Premier article prononcé conforme : la série est autorisée."
            : "Premier article exigé par le plan de contrôle. La série reste interdite tant que la Qualité n'a pas tranché."
          : "Aucun premier article exigé par le plan de contrôle applicable.",
      },
      instruments,
    },

    machine_documents: (r.machine_documents ?? []).map((d: any) => ({
      id: d.id,
      title: d.title,
      document_type: d.document_type,
      revision: d.revision,
      mime_type: d.mime_type,
      size_bytes: d.size_bytes ? Number(d.size_bytes) : null,
      sha256: d.sha256,
      url: d.url,
    })),

    hierarchy: {
      parent: r.parent ?? null,
      children: (r.children ?? []).map((c: any) => ({
        of_id: Number(c.of_id),
        numero: c.numero,
        statut: c.statut,
        piece_code: c.piece_code,
        piece_designation: c.piece_designation,
        quantite_lancee: Number(c.quantite_lancee ?? 0),
        quantite_bonne: Number(c.quantite_bonne ?? 0),
        quantite_rebut: Number(c.quantite_rebut ?? 0),
      })),
      structure_path: core.structure_path ?? null,
    },

    execution: {
      active: r.active_execution ?? null,
      declarations,
    },

    pending_handover: r.pending_handover ?? null,

    next_business_actions: nextActions,

    // Ce que le poste ne fera JAMAIS, affiché à l'opérateur pour qu'il ne
    // suppose pas d'effets invisibles.
    boundaries: [
      "Aucune donnée de présence RH n'est créée par ce poste.",
      "Aucun mouvement de stock n'est déclenché depuis cet écran.",
      "Aucun programme n'est envoyé vers une commande numérique.",
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Transmission de poste                                                      */
/* -------------------------------------------------------------------------- */

export async function svcCreateHandover(params: {
  station: StationContext;
  body: StationHandoverDTO;
  idempotencyKey: string;
}): Promise<Record<string, unknown>> {
  assertHandoverParties({
    outgoingUserId: params.station.user.id,
    incomingUserId: params.body.incoming_user_id,
  });

  const handover = await repoCreateHandover({
    device_id: params.station.device_id,
    machine_id: params.station.machine_id,
    of_id: params.body.of_id ?? null,
    operation_id: params.body.operation_id ?? null,
    pointage_id: params.body.pointage_id ?? null,
    outgoing_user_id: params.station.user.id,
    incoming_user_id: params.body.incoming_user_id,
    machine_state: params.body.machine_state,
    qty_done: params.body.qty_done ?? null,
    defects: params.body.defects ?? null,
    tooling_left: params.body.tooling_left ?? null,
    remaining_actions: params.body.remaining_actions ?? null,
    comment: params.body.comment ?? null,
    idempotency_key: params.idempotencyKey,
  });

  return {
    handover,
    // Une transmission décrit ; elle ne débite aucun temps et n'écrit rien en RH.
    notice:
      "Transmission enregistrée. Elle ne modifie aucun temps déjà déclaré et ne crée aucune donnée de présence RH.",
  };
}

export async function svcListHandovers(params: {
  station: StationContext;
  onlyPending: boolean;
}): Promise<Record<string, unknown>> {
  const items = await repoListHandoversForUser({
    userId: params.station.user.id,
    onlyPending: params.onlyPending,
    limit: 50,
  });
  return { total: items.length, items };
}

export async function svcAcknowledgeHandover(params: {
  station: StationContext;
  id: string;
}): Promise<Record<string, unknown>> {
  const existing = await repoGetHandover(params.id);
  if (!existing) throw new HttpError(404, "STATION_HANDOVER_UNKNOWN", "Transmission introuvable.");

  assertHandoverAcknowledgeable({
    incomingUserId: existing.incoming_user.id,
    actorUserId: params.station.user.id,
    actorRole: params.station.user.role,
    alreadyAcknowledgedAt: existing.acknowledged_at ? new Date(existing.acknowledged_at) : null,
  });

  const updated = await repoAcknowledgeHandover({ id: params.id, actorUserId: params.station.user.id });
  return { handover: updated };
}

/* -------------------------------------------------------------------------- */
/* Administration des appareils et supports                                   */
/* -------------------------------------------------------------------------- */

export async function svcEnrollDevice(params: {
  actor: Actor;
  body: EnrollDeviceDTO;
}): Promise<DeviceRow> {
  return repoEnrollDevice({
    label: params.body.label,
    code_prefix: params.body.code_prefix,
    site: params.body.site ?? null,
    workshop_zone: params.body.workshop_zone ?? null,
    assignment_mode: params.body.assignment_mode,
    machine_id: params.body.machine_id ?? null,
    auto_lock_seconds: params.body.auto_lock_seconds,
    session_max_seconds: params.body.session_max_seconds,
    actorUserId: params.actor.id,
  });
}

export async function svcUpdateDevice(params: {
  actor: Actor;
  id: string;
  body: UpdateDeviceDTO;
}): Promise<DeviceRow> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params.body)) {
    if (value !== undefined) patch[key] = value;
  }
  return repoUpdateDevice({ id: params.id, patch, actorUserId: params.actor.id });
}

export async function svcRevokeDevice(params: {
  actor: Actor;
  id: string;
  reason: string;
}): Promise<Record<string, unknown>> {
  const result = await repoRevokeDevice({
    id: params.id,
    reason: params.reason,
    actorUserId: params.actor.id,
  });
  return {
    device: result.device,
    closed_sessions: result.closed_sessions,
    // Révoquer une tablette ferme des sessions ; cela n'arrête AUCUN pointage.
    notice:
      "Tablette révoquée et sessions fermées. Les pointages en cours ne sont pas arrêtés : ils restent la propriété du suivi de production.",
  };
}

export async function svcListDevices(params: { query: ListDevicesQueryDTO }): Promise<DeviceRow[]> {
  return repoListDevices({
    status: params.query.status,
    workshop_zone: params.query.workshop_zone,
    q: params.query.q,
    limit: params.query.limit,
  });
}

export async function svcIssueCredential(params: {
  actor: Actor;
  body: IssueCredentialDTO;
}): Promise<Record<string, unknown>> {
  const created = await repoIssueCredential({
    user_id: params.body.user_id,
    credential_type: params.body.credential_type,
    credential: params.body.credential,
    label: params.body.label ?? null,
    actorUserId: params.actor.id,
  });
  // L'empreinte n'est jamais renvoyée : elle ne quitte pas la base.
  return { credential: created };
}

export async function svcRevokeCredential(params: {
  actor: Actor;
  id: string;
  reason: string;
}): Promise<Record<string, unknown>> {
  await repoRevokeCredential({ id: params.id, reason: params.reason, actorUserId: params.actor.id });
  return { revoked: true };
}

export async function svcListCredentials(params: {
  actor: Actor;
  userId: number;
}): Promise<Record<string, unknown>> {
  // Anti-IDOR : on ne liste les supports d'un tiers qu'avec la capacité
  // d'administration.
  if (params.actor.id !== params.userId) {
    if (!roleHasStationCapability(params.actor.role, "administer_credentials")) {
      throw new HttpError(
        403,
        "STATION_CAPABILITY_REQUIRED",
        "La capacité de poste 'administer_credentials' est requise."
      );
    }
  }
  const items = await repoListCredentials(params.userId);
  return { total: items.length, items };
}

export async function svcStationAudit(params: {
  query: StationAuditQueryDTO;
}): Promise<Record<string, unknown>> {
  const items = await repoListStationAudit({
    device_id: params.query.device_id,
    user_id: params.query.user_id,
    event_type: params.query.event_type,
    outcome: params.query.outcome,
    limit: params.query.limit,
  });
  return { total: items.length, items };
}

export async function svcSessionOwnershipGuard(params: {
  actor: Actor;
  sessionUserId: number;
  action: string;
}): Promise<void> {
  assertOwnSessionOrSupervision({
    actorUserId: params.actor.id,
    actorRole: params.actor.role,
    sessionUserId: params.sessionUserId,
    action: params.action,
  });
}
