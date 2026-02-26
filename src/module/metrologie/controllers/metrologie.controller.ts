import type { Request, RequestHandler } from "express";
import fs from "node:fs/promises";
import path from "node:path";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import { emitEntityChanged } from "../../../shared/realtime/realtime.service";

import type { AuditContext } from "../repository/metrologie.repository";
import {
  certificatIdParamSchema,
  createCertificatSchema,
  createEquipementSchema,
  equipementIdParamSchema,
  listEquipementsQuerySchema,
  patchEquipementSchema,
  upsertPlanSchema,
} from "../validators/metrologie.validators";
import {
  svcAttachCertificats,
  svcCreateEquipement,
  svcDeleteEquipement,
  svcGetAlerts,
  svcGetAlertsSummary,
  svcGetCertificatForDownload,
  svcGetEquipementDetail,
  svcGetKpis,
  svcListCertificats,
  svcListEquipements,
  svcMetrologieDocsBaseDir,
  svcPatchEquipement,
  svcRemoveCertificat,
  svcUpsertPlan,
} from "../services/metrologie.service";

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

function getUserRef(req: Request): { id: number; name: string } {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  }
  const name = typeof user.username === "string" && user.username.trim() ? user.username.trim() : String(user.id);
  return { id: user.id, name };
}

function emitEquipementChanged(req: Request, params: { equipementId: string; action: "created" | "updated" | "deleted" | "status_changed" }) {
  const equipementId = params.equipementId;
  emitEntityChanged({
    entityType: "METROLOGIE_EQUIPEMENT",
    entityId: equipementId,
    action: params.action,
    module: "metrologie",
    at: new Date().toISOString(),
    by: getUserRef(req),
    invalidateKeys: [
      "metrologie:equipements",
      "metrologie:kpis",
      "metrologie:alerts",
      `metrologie:equipement:${equipementId}`,
    ],
  });
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

export const listEquipements: RequestHandler = asyncHandler(async (req, res) => {
  const query = listEquipementsQuerySchema.parse(req.query);
  const out = await svcListEquipements(query);
  res.json(out);
});

export const metrologieKpis: RequestHandler = asyncHandler(async (_req, res) => {
  const out = await svcGetKpis();
  res.json(out);
});

export const metrologieAlerts: RequestHandler = asyncHandler(async (_req, res) => {
  const out = await svcGetAlerts();
  res.json(out);
});

export const metrologieAlertsSummary: RequestHandler = asyncHandler(async (_req, res) => {
  const out = await svcGetAlertsSummary();
  res.json(out);
});

export const getEquipement: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = equipementIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetEquipementDetail(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const createEquipement: RequestHandler = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const body = createEquipementSchema.parse({ body: req.body }).body;
  const out = await svcCreateEquipement(body, audit);
  emitEquipementChanged(req, { equipementId: out.equipement.id, action: "created" });
  res.status(201).json(out);
});

export const patchEquipement: RequestHandler = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = equipementIdParamSchema.parse({ params: req.params }).params;
  const body = patchEquipementSchema.parse({ body: req.body }).body;
  const out = await svcPatchEquipement(id, body, audit);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  emitEquipementChanged(req, { equipementId: id, action: "updated" });
  res.json(out);
});

export const deleteEquipement: RequestHandler = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = equipementIdParamSchema.parse({ params: req.params }).params;
  const ok = await svcDeleteEquipement(id, audit);
  if (!ok) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  emitEquipementChanged(req, { equipementId: id, action: "deleted" });
  res.status(204).send();
});

export const upsertPlan: RequestHandler = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = equipementIdParamSchema.parse({ params: req.params }).params;
  const body = upsertPlanSchema.parse({ body: req.body }).body;
  const out = await svcUpsertPlan(id, body, audit);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  emitEquipementChanged(req, { equipementId: id, action: "status_changed" });
  res.json(out);
});

export const listCertificats: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = equipementIdParamSchema.parse({ params: req.params }).params;
  const out = await svcListCertificats(id);
  if (out === null) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const attachCertificats: RequestHandler = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = equipementIdParamSchema.parse({ params: req.params }).params;
  const body = createCertificatSchema.parse({ body: req.body }).body;
  const files = getMulterFiles(req);
  const out = await svcAttachCertificats({ equipement_id: id, body, documents: files, audit });
  if (out === null) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  emitEquipementChanged(req, { equipementId: id, action: "updated" });
  res.status(201).json(out);
});

export const removeCertificat: RequestHandler = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id, certificatId } = certificatIdParamSchema.parse({ params: req.params }).params;
  const out = await svcRemoveCertificat({ equipement_id: id, certificat_id: certificatId, audit });
  if (out === null) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  emitEquipementChanged(req, { equipementId: id, action: "updated" });
  res.status(204).send();
});

export const downloadCertificatFile: RequestHandler = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id, certificatId } = certificatIdParamSchema.parse({ params: req.params }).params;
  const doc = await svcGetCertificatForDownload({ equipement_id: id, certificat_id: certificatId, audit });
  if (!doc || !doc.storage_path) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const baseDir = svcMetrologieDocsBaseDir();
  const absPath = path.resolve(doc.storage_path);
  const basePrefix = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`;
  if (!absPath.startsWith(basePrefix)) {
    throw new HttpError(400, "INVALID_STORAGE_PATH", "Invalid document storage path");
  }

  await fs.access(absPath);
  res.setHeader("Content-Type", doc.mime_type ?? "application/octet-stream");

  const rawDownload = (req.query as { download?: unknown } | undefined)?.download;
  const download = rawDownload === true || rawDownload === "true" || rawDownload === "1" || rawDownload === 1;
  const name = doc.file_original_name ?? `certificat-${certificatId}`;
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(name)}"`
  );
  res.sendFile(absPath);
});
