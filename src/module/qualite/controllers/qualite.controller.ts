import type { Request, RequestHandler } from "express";
import fs from "node:fs/promises";
import path from "node:path";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";

import type { AuditContext } from "../repository/qualite.repository";
import {
  actionIdParamSchema,
  attachDocumentsSchema,
  controlIdParamSchema,
  createActionSchema,
  createControlSchema,
  createNonConformitySchema,
  documentIdParamSchema,
  kpisQuerySchema,
  listActionsQuerySchema,
  listControlsQuerySchema,
  listNonConformitiesQuerySchema,
  listUsersQuerySchema,
  nonConformityIdParamSchema,
  patchActionSchema,
  patchControlSchema,
  patchNonConformitySchema,
  validateControlSchema,
} from "../validators/qualite.validators";
import {
  svcAttachDocuments,
  svcCreateAction,
  svcCreateControl,
  svcCreateNonConformity,
  svcGetAction,
  svcGetControl,
  svcGetDocumentForDownload,
  svcGetNonConformity,
  svcKpis,
  svcListActions,
  svcListControls,
  svcListDocuments,
  svcListNonConformities,
  svcListUsers,
  svcPatchAction,
  svcPatchControl,
  svcPatchNonConformity,
  svcQualityDocumentBaseDir,
  svcRemoveDocument,
  svcValidateControl,
} from "../services/qualite.service";

function buildAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  }

  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const ip = getClientIp(req);
  const device = parseDevice(userAgent);
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null;
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;

  return {
    user_id: user.id,
    ip,
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

function isMulterFile(value: unknown): value is Express.Multer.File {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { path?: unknown; originalname?: unknown; mimetype?: unknown; size?: unknown };
  return typeof v.path === "string" && typeof v.originalname === "string" && typeof v.mimetype === "string" && typeof v.size === "number";
}

function getMulterFiles(req: Request): Express.Multer.File[] {
  const files = (req as Request & { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  return files.filter(isMulterFile);
}

export const qualiteKpis = asyncHandler(async (req, res) => {
  const query = kpisQuerySchema.parse(req.query);
  const out = await svcKpis(query);
  res.json(out);
});

export const listQualityUsers = asyncHandler(async (req, res) => {
  const query = listUsersQuerySchema.parse(req.query);
  const out = await svcListUsers(query);
  res.json(out);
});

// Controls
export const listControls = asyncHandler(async (req, res) => {
  const query = listControlsQuerySchema.parse(req.query);
  const out = await svcListControls(query);
  res.json(out);
});

export const getControl = asyncHandler(async (req, res) => {
  const { id } = controlIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetControl(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const createControl = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const body = createControlSchema.parse({ body: req.body }).body;
  const out = await svcCreateControl({ body, audit });
  res.status(201).json(out);
});

export const patchControl = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = controlIdParamSchema.parse({ params: req.params }).params;
  const body = patchControlSchema.parse({ body: req.body }).body;
  const out = await svcPatchControl({ id, body, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const validateControl = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = controlIdParamSchema.parse({ params: req.params }).params;
  const body = validateControlSchema.parse({ body: req.body }).body;
  const out = await svcValidateControl({ id, body, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

// Non conformities
export const listNonConformities = asyncHandler(async (req, res) => {
  const query = listNonConformitiesQuerySchema.parse(req.query);
  const out = await svcListNonConformities(query);
  res.json(out);
});

export const getNonConformity = asyncHandler(async (req, res) => {
  const { id } = nonConformityIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetNonConformity(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const createNonConformity = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const body = createNonConformitySchema.parse({ body: req.body }).body;
  const out = await svcCreateNonConformity({ body, audit });
  res.status(201).json(out);
});

export const patchNonConformity = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = nonConformityIdParamSchema.parse({ params: req.params }).params;
  const body = patchNonConformitySchema.parse({ body: req.body }).body;
  const out = await svcPatchNonConformity({ id, body, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

// Actions
export const listActions = asyncHandler(async (req, res) => {
  const query = listActionsQuerySchema.parse(req.query);
  const out = await svcListActions(query);
  res.json(out);
});

export const getAction = asyncHandler(async (req, res) => {
  const { id } = actionIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetAction(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const createAction = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const body = createActionSchema.parse({ body: req.body }).body;
  const out = await svcCreateAction({ body, audit });
  res.status(201).json(out);
});

export const patchAction = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = actionIdParamSchema.parse({ params: req.params }).params;
  const body = patchActionSchema.parse({ body: req.body }).body;
  const out = await svcPatchAction({ id, body, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

// Documents
async function downloadDocHandler(req: Request, res: Parameters<RequestHandler>[1], entityType: "CONTROL" | "NON_CONFORMITY" | "ACTION") {
  const audit = buildAuditContext(req);
  const { id, docId } = documentIdParamSchema.parse({ params: req.params }).params;
  const doc = await svcGetDocumentForDownload({ entity_type: entityType, entity_id: id, doc_id: docId, audit });
  if (!doc) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const baseDir = svcQualityDocumentBaseDir();
  const absPath = path.resolve(doc.storage_path);
  const basePrefix = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`;
  if (!absPath.startsWith(basePrefix)) {
    throw new HttpError(400, "INVALID_STORAGE_PATH", "Invalid document storage path");
  }
  await fs.access(absPath);

  res.setHeader("Content-Type", doc.mime_type);
  const rawDownload = (req.query as { download?: unknown } | undefined)?.download;
  const download = rawDownload === true || rawDownload === "true" || rawDownload === "1" || rawDownload === 1;
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(doc.original_name)}"`
  );
  res.sendFile(absPath);
}

export const listControlDocuments = asyncHandler(async (req, res) => {
  const { id } = controlIdParamSchema.parse({ params: req.params }).params;
  const out = await svcListDocuments("CONTROL", id);
  res.json(out);
});

export const attachControlDocuments = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = controlIdParamSchema.parse({ params: req.params }).params;
  const body = attachDocumentsSchema.parse({ body: req.body }).body;
  const files = getMulterFiles(req);
  const out = await svcAttachDocuments({
    entity_type: "CONTROL",
    entity_id: id,
    document_type: body.document_type,
    documents: files,
    audit,
  });
  res.status(201).json(out);
});

export const removeControlDocument = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id, docId } = documentIdParamSchema.parse({ params: req.params }).params;
  const ok = await svcRemoveDocument({ entity_type: "CONTROL", entity_id: id, doc_id: docId, audit });
  if (!ok) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).send();
});

export const downloadControlDocument = asyncHandler(async (req, res) => downloadDocHandler(req, res, "CONTROL"));

export const listNonConformityDocuments = asyncHandler(async (req, res) => {
  const { id } = nonConformityIdParamSchema.parse({ params: req.params }).params;
  const out = await svcListDocuments("NON_CONFORMITY", id);
  res.json(out);
});

export const attachNonConformityDocuments = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = nonConformityIdParamSchema.parse({ params: req.params }).params;
  const body = attachDocumentsSchema.parse({ body: req.body }).body;
  const files = getMulterFiles(req);
  const out = await svcAttachDocuments({
    entity_type: "NON_CONFORMITY",
    entity_id: id,
    document_type: body.document_type,
    documents: files,
    audit,
  });
  res.status(201).json(out);
});

export const removeNonConformityDocument = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id, docId } = documentIdParamSchema.parse({ params: req.params }).params;
  const ok = await svcRemoveDocument({ entity_type: "NON_CONFORMITY", entity_id: id, doc_id: docId, audit });
  if (!ok) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).send();
});

export const downloadNonConformityDocument = asyncHandler(async (req, res) => downloadDocHandler(req, res, "NON_CONFORMITY"));

export const listActionDocuments = asyncHandler(async (req, res) => {
  const { id } = actionIdParamSchema.parse({ params: req.params }).params;
  const out = await svcListDocuments("ACTION", id);
  res.json(out);
});

export const attachActionDocuments = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = actionIdParamSchema.parse({ params: req.params }).params;
  const body = attachDocumentsSchema.parse({ body: req.body }).body;
  const files = getMulterFiles(req);
  const out = await svcAttachDocuments({
    entity_type: "ACTION",
    entity_id: id,
    document_type: body.document_type,
    documents: files,
    audit,
  });
  res.status(201).json(out);
});

export const removeActionDocument = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id, docId } = documentIdParamSchema.parse({ params: req.params }).params;
  const ok = await svcRemoveDocument({ entity_type: "ACTION", entity_id: id, doc_id: docId, audit });
  if (!ok) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).send();
});

export const downloadActionDocument = asyncHandler(async (req, res) => downloadDocHandler(req, res, "ACTION"));
