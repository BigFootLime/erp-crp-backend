// Contrôleurs du poste opérateur tablette (#159).
//
// Rôle strictement limité : valider l'entrée (Zod), extraire l'acteur depuis la
// SESSION ou le JWT — jamais depuis le corps de requête — et déléguer au
// service. Aucune règle métier ici.

import type { Request, Response } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";

import {
  clearStationSessionCookie,
  setStationSessionCookie,
  type StationContext,
} from "../middlewares/station-authorization.middleware";
import {
  enrollDeviceSchema,
  issueCredentialSchema,
  listDevicesQuerySchema,
  revokeCredentialSchema,
  revokeDeviceSchema,
  stationAuditQuerySchema,
  stationBootstrapQuerySchema,
  stationCloseSchema,
  stationConfirmMachineSchema,
  stationDossierParamsSchema,
  stationHandoverAckSchema,
  stationHandoverSchema,
  stationHeartbeatSchema,
  stationIdentifySchema,
  stationLockSchema,
  stationScanSchema,
  stationUnlockSchema,
  stationWorklistQuerySchema,
  updateDeviceSchema,
} from "../validators/station.validators";
import {
  svcAcknowledgeHandover,
  svcBootstrap,
  svcCloseSession,
  svcConfirmMachine,
  svcCreateHandover,
  svcDossier,
  svcEnrollDevice,
  svcHeartbeat,
  svcIdentify,
  svcIssueCredential,
  svcListCredentials,
  svcListDevices,
  svcListHandovers,
  svcListMachines,
  svcLock,
  svcRevokeCredential,
  svcRevokeDevice,
  svcScan,
  svcStationAudit,
  svcUnlock,
  svcUpdateDevice,
  svcWorklist,
  type Actor,
} from "../services/station.service";

/** Acteur ERP (JWT). Jamais l'identité d'un poste. */
function jwtActor(req: Request): Actor | null {
  const user = req.user;
  if (!user || typeof user.id !== "number") return null;
  return { id: user.id, role: user.role ?? null };
}

/** Acteur de poste. C'est la SEULE identité acceptée par les routes tablette. */
function requireStation(req: Request): StationContext {
  if (!req.station) {
    throw new HttpError(401, "STATION_SESSION_REQUIRED", "Identifiez-vous sur la tablette.");
  }
  return req.station;
}

/** Acteur d'administration : JWT ERP, pas une session de poste. */
function requireAdminActor(req: Request): Actor {
  const actor = jwtActor(req);
  if (!actor) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return actor;
}

function idempotencyKey(req: Request): string {
  const raw = req.headers["idempotency-key"];
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Clé d'idempotence manquante.");
  return key;
}

function requestId(req: Request): string | null {
  return req.requestId ?? null;
}

/* -------------------------------------------------------------------------- */
/* Bootstrap et session                                                       */
/* -------------------------------------------------------------------------- */

export const bootstrap = asyncHandler(async (req: Request, res: Response) => {
  const query = stationBootstrapQuerySchema.parse(req.query);
  const payload = await svcBootstrap({
    query,
    station: req.station,
    jwtActor: jwtActor(req),
  });
  res.json(payload);
});

export const identify = asyncHandler(async (req: Request, res: Response) => {
  const body = stationIdentifySchema.parse(req.body);
  const result = await svcIdentify({
    body,
    jwtActor: jwtActor(req),
    requestId: requestId(req),
  });

  // Le jeton part en cookie httpOnly : le JavaScript de la page ne le lit
  // jamais, une XSS ne l'exfiltre donc pas. Il est AUSSI renvoyé une fois dans
  // le corps pour les configurations où le cookie tiers est supprimé par un
  // proxy ; le client le garde alors en mémoire seulement.
  setStationSessionCookie(res, result.token, result.maxAgeSeconds);
  res.status(201).json({ ...result.payload, session_token: result.token });
});

export const unlock = asyncHandler(async (req: Request, res: Response) => {
  const body = stationUnlockSchema.parse(req.body);
  const deviceCode = typeof req.body?.device_code === "string" ? req.body.device_code : null;
  if (!deviceCode) {
    throw new HttpError(400, "STATION_DEVICE_CODE_REQUIRED", "Code de tablette manquant.");
  }
  const result = await svcUnlock({
    device_code: deviceCode,
    body,
    jwtActor: jwtActor(req),
    sessionToken: null,
    requestId: requestId(req),
  });
  setStationSessionCookie(res, result.token, result.maxAgeSeconds);
  res.status(201).json({ ...result.payload, session_token: result.token });
});

export const lock = asyncHandler(async (req: Request, res: Response) => {
  const body = stationLockSchema.parse(req.body ?? {});
  res.json(await svcLock({ station: requireStation(req), body }));
});

export const closeSession = asyncHandler(async (req: Request, res: Response) => {
  const body = stationCloseSchema.parse(req.body ?? {});
  const payload = await svcCloseSession({ station: requireStation(req), body });
  clearStationSessionCookie(res);
  res.json(payload);
});

export const heartbeat = asyncHandler(async (req: Request, res: Response) => {
  const body = stationHeartbeatSchema.parse(req.body ?? {});
  res.json(await svcHeartbeat({ station: requireStation(req), body }));
});

/* -------------------------------------------------------------------------- */
/* Machines                                                                   */
/* -------------------------------------------------------------------------- */

export const listMachines = asyncHandler(async (req: Request, res: Response) => {
  res.json(await svcListMachines({ station: requireStation(req) }));
});

export const confirmMachine = asyncHandler(async (req: Request, res: Response) => {
  const body = stationConfirmMachineSchema.parse(req.body);
  res.json(await svcConfirmMachine({ station: requireStation(req), body }));
});

/* -------------------------------------------------------------------------- */
/* File de travail et dossier                                                 */
/* -------------------------------------------------------------------------- */

export const worklist = asyncHandler(async (req: Request, res: Response) => {
  const query = stationWorklistQuerySchema.parse(req.query);
  res.json(await svcWorklist({ station: requireStation(req), query }));
});

export const scan = asyncHandler(async (req: Request, res: Response) => {
  const body = stationScanSchema.parse(req.body);
  res.json(await svcScan({ station: requireStation(req), body }));
});

export const dossier = asyncHandler(async (req: Request, res: Response) => {
  const params = stationDossierParamsSchema.parse(req.params);
  res.json(
    await svcDossier({
      station: requireStation(req),
      ofId: params.ofId,
      operationId: params.operationId,
    })
  );
});

/* -------------------------------------------------------------------------- */
/* Transmission de poste                                                      */
/* -------------------------------------------------------------------------- */

export const createHandover = asyncHandler(async (req: Request, res: Response) => {
  const body = stationHandoverSchema.parse(req.body);
  res.status(201).json(
    await svcCreateHandover({
      station: requireStation(req),
      body,
      idempotencyKey: idempotencyKey(req),
    })
  );
});

export const listHandovers = asyncHandler(async (req: Request, res: Response) => {
  const onlyPending = String(req.query.pending ?? "") === "true";
  res.json(await svcListHandovers({ station: requireStation(req), onlyPending }));
});

export const acknowledgeHandover = asyncHandler(async (req: Request, res: Response) => {
  stationHandoverAckSchema.parse(req.body ?? {});
  const id = String(req.params.id ?? "");
  res.json(await svcAcknowledgeHandover({ station: requireStation(req), id }));
});

/* -------------------------------------------------------------------------- */
/* Administration                                                             */
/* -------------------------------------------------------------------------- */

export const enrollDevice = asyncHandler(async (req: Request, res: Response) => {
  const body = enrollDeviceSchema.parse(req.body);
  res.status(201).json({ device: await svcEnrollDevice({ actor: requireAdminActor(req), body }) });
});

export const updateDevice = asyncHandler(async (req: Request, res: Response) => {
  const body = updateDeviceSchema.parse(req.body);
  res.json({
    device: await svcUpdateDevice({
      actor: requireAdminActor(req),
      id: String(req.params.id ?? ""),
      body,
    }),
  });
});

export const revokeDevice = asyncHandler(async (req: Request, res: Response) => {
  const body = revokeDeviceSchema.parse(req.body);
  res.json(
    await svcRevokeDevice({
      actor: requireAdminActor(req),
      id: String(req.params.id ?? ""),
      reason: body.reason,
    })
  );
});

export const listDevices = asyncHandler(async (req: Request, res: Response) => {
  const query = listDevicesQuerySchema.parse(req.query);
  const devices = await svcListDevices({ query });
  res.json({ total: devices.length, items: devices });
});

export const issueCredential = asyncHandler(async (req: Request, res: Response) => {
  const body = issueCredentialSchema.parse(req.body);
  res.status(201).json(await svcIssueCredential({ actor: requireAdminActor(req), body }));
});

export const revokeCredential = asyncHandler(async (req: Request, res: Response) => {
  const body = revokeCredentialSchema.parse(req.body);
  res.json(
    await svcRevokeCredential({
      actor: requireAdminActor(req),
      id: String(req.params.id ?? ""),
      reason: body.reason,
    })
  );
});

export const listCredentials = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireAdminActor(req);
  const userId = Number(req.params.userId ?? actor.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new HttpError(400, "STATION_USER_INVALID", "Identifiant utilisateur invalide.");
  }
  res.json(await svcListCredentials({ actor, userId }));
});

export const stationAudit = asyncHandler(async (req: Request, res: Response) => {
  const query = stationAuditQuerySchema.parse(req.query);
  res.json(await svcStationAudit({ query }));
});
