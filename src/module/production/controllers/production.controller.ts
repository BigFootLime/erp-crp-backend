import type { Request } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../repository/production.repository";
import {
  createMachineSchema,
  createOfSchema,
  createPosteSchema,
  listMachinesQuerySchema,
  listOfQuerySchema,
  listPostesQuerySchema,
  machineIdParamSchema,
  ofIdParamSchema,
  ofOperationIdParamSchema,
  posteIdParamSchema,
  startOfTimeLogSchema,
  stopOfTimeLogSchema,
  updateMachineSchema,
  updateOfOperationSchema,
  updateOfSchema,
  updatePosteSchema,
} from "../validators/production.validators";
import {
  svcArchiveMachine,
  svcArchivePoste,
  svcCreateMachine,
  svcCreateOrdreFabrication,
  svcCreatePoste,
  svcGetOrdreFabrication,
  svcGetMachine,
  svcGetPoste,
  svcListOrdresFabrication,
  svcListMachines,
  svcListPostes,
  svcStartOfOperationTimeLog,
  svcStopOfOperationTimeLog,
  svcUpdateOrdreFabrication,
  svcUpdateOrdreFabricationOperation,
  svcUpdateMachine,
  svcUpdatePoste,
} from "../services/production.service";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseBody(req: Request): unknown {
  const body = req.body as unknown;
  if (!isRecord(body)) return body;
  const data = body.data;
  if (typeof data !== "string") return body;
  try {
    return JSON.parse(data);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON payload in 'data'");
  }
}

function isMulterFile(value: unknown): value is Express.Multer.File {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    typeof value.originalname === "string" &&
    typeof value.mimetype === "string" &&
    typeof value.size === "number"
  );
}

function buildAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");

  const forwardedFor = req.headers["x-forwarded-for"];
  const ipFromHeader = typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : null;
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null;
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;

  return {
    user_id: user.id,
    ip: ipFromHeader ?? req.ip ?? null,
    user_agent: ua,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

export const listMachines = asyncHandler(async (req, res) => {
  const query = listMachinesQuerySchema.parse(req.query);
  const out = await svcListMachines(query);
  res.json(out);
});

export const getMachine = asyncHandler(async (req, res) => {
  const { id } = machineIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetMachine(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const createMachine = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const raw = parseBody(req);
  const body = createMachineSchema.parse({ body: raw }).body;
  const file = (req as Request & { file?: unknown }).file;
  const imagePath = isMulterFile(file) ? file.path : null;
  const out = await svcCreateMachine({ body, image_path: imagePath, audit });
  res.status(201).json(out);
});

export const updateMachine = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = machineIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const patch = updateMachineSchema.parse({ body: raw }).body;
  const file = (req as Request & { file?: unknown }).file;
  const imagePath = isMulterFile(file) ? file.path : undefined;
  const out = await svcUpdateMachine({ id, patch, image_path: imagePath, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(200).json(out);
});

export const archiveMachine = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = machineIdParamSchema.parse({ params: req.params }).params;
  const out = await svcArchiveMachine({ id, audit });
  if (out === null) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).send();
});

export const listPostes = asyncHandler(async (req, res) => {
  const query = listPostesQuerySchema.parse(req.query);
  const out = await svcListPostes(query);
  res.json(out);
});

export const getPoste = asyncHandler(async (req, res) => {
  const { id } = posteIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetPoste(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const createPoste = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const raw = parseBody(req);
  const body = createPosteSchema.parse({ body: raw }).body;
  const out = await svcCreatePoste({ body, audit });
  res.status(201).json(out);
});

export const updatePoste = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = posteIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const patch = updatePosteSchema.parse({ body: raw }).body;
  const out = await svcUpdatePoste({ id, patch, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(200).json(out);
});

export const archivePoste = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = posteIdParamSchema.parse({ params: req.params }).params;
  const out = await svcArchivePoste({ id, audit });
  if (out === null) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).send();
});

// -------------------------
// OF
// -------------------------

export const listOrdresFabrication = asyncHandler(async (req, res) => {
  const query = listOfQuerySchema.parse(req.query);
  const out = await svcListOrdresFabrication(query);
  res.json(out);
});

export const getOrdreFabrication = asyncHandler(async (req, res) => {
  const { id } = ofIdParamSchema.parse({ params: req.params }).params;
  const userId = typeof req.user?.id === "number" ? req.user.id : undefined;
  const out = await svcGetOrdreFabrication({ id, user_id: userId });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const createOrdreFabrication = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const raw = parseBody(req);
  const body = createOfSchema.parse({ body: raw }).body;
  const out = await svcCreateOrdreFabrication({ body, audit });
  res.status(201).json(out);
});

export const updateOrdreFabrication = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = ofIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const patch = updateOfSchema.parse({ body: raw }).body;
  const out = await svcUpdateOrdreFabrication({ id, patch, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(200).json(out);
});

export const updateOrdreFabricationOperation = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id, opId } = ofOperationIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const patch = updateOfOperationSchema.parse({ body: raw }).body;
  const out = await svcUpdateOrdreFabricationOperation({ of_id: id, op_id: opId, patch, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(200).json(out);
});

export const startOfOperationTimeLog = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id, opId } = ofOperationIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const body = startOfTimeLogSchema.parse({ body: raw }).body;
  const out = await svcStartOfOperationTimeLog({ of_id: id, op_id: opId, body, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(201).json(out);
});

export const stopOfOperationTimeLog = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id, opId } = ofOperationIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const body = stopOfTimeLogSchema.parse({ body: raw }).body;
  const out = await svcStopOfOperationTimeLog({ of_id: id, op_id: opId, body, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(200).json(out);
});
