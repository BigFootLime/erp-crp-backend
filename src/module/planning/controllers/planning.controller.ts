import type { Request } from "express";
import type { RequestHandler } from "express";
import fs from "node:fs/promises";
import path from "node:path";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../repository/planning.repository";
import {
  createPlanningEventCommentSchema,
  createPlanningEventSchema,
  listPlanningEventsQuerySchema,
  listPlanningResourcesQuerySchema,
  patchPlanningEventSchema,
  planningEventDocumentIdParamSchema,
  planningEventIdParamSchema,
} from "../validators/planning.validators";
import {
  svcArchivePlanningEvent,
  svcCreatePlanningEvent,
  svcCreatePlanningEventComment,
  svcGetPlanningEventDetail,
  svcGetPlanningEventDocumentFileMeta,
  svcListPlanningEvents,
  svcListPlanningResources,
  svcPatchPlanningEvent,
  svcUploadPlanningEventDocuments,
} from "../services/planning.service";

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

function resolveMimeType(value: string | null | undefined): string {
  const t = String(value ?? "").trim().toLowerCase();
  if (!t) return "application/octet-stream";
  if (t === "pdf" || t.includes("pdf")) return "application/pdf";
  if (t.includes("/")) return t;
  return "application/octet-stream";
}

function safeExtFromName(name: string): string {
  const extCandidate = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : "";
}

type UploadedDocument = {
  originalname: string;
  path: string;
  mimetype: string;
  size?: number;
};

function getUploadedDocuments(req: Request): UploadedDocument[] {
  const filesValue = (req as unknown as { files?: unknown }).files;
  const files = Array.isArray(filesValue) ? (filesValue as Express.Multer.File[]) : [];
  return files.map((f) => ({
    originalname: f.originalname,
    path: f.path,
    mimetype: f.mimetype,
    size: f.size,
  }));
}

export const listPlanningResources: RequestHandler = asyncHandler(async (req, res) => {
  const query = listPlanningResourcesQuerySchema.parse(req.query);
  const out = await svcListPlanningResources(query);
  res.json(out);
});

export const listPlanningEvents: RequestHandler = asyncHandler(async (req, res) => {
  const query = listPlanningEventsQuerySchema.parse(req.query);
  const out = await svcListPlanningEvents(query);
  res.json(out);
});

export const getPlanningEvent: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = planningEventIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetPlanningEventDetail(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const createPlanningEvent: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body = createPlanningEventSchema.parse({ body: req.body }).body;
    const out = await svcCreatePlanningEvent({ body, audit });
    res.status(201).json(out);
  } catch (err) {
    if (err instanceof HttpError && err.code === "PLANNING_CONFLICT") {
      res.status(err.status).json({
        success: false,
        message: err.message,
        code: err.code,
        path: req.originalUrl,
        details: err.details ?? null,
      });
      return;
    }
    next(err);
  }
};

export const patchPlanningEvent: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = planningEventIdParamSchema.parse({ params: req.params }).params;
    const patch = patchPlanningEventSchema.parse({ body: req.body }).body.patch;
    const out = await svcPatchPlanningEvent({ id, patch, audit });
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    if (err instanceof HttpError && (err.code === "PLANNING_CONFLICT" || err.code === "PLANNING_STALE")) {
      res.status(err.status).json({
        success: false,
        message: err.message,
        code: err.code,
        path: req.originalUrl,
        details: err.details ?? null,
      });
      return;
    }
    next(err);
  }
};

export const archivePlanningEvent: RequestHandler = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = planningEventIdParamSchema.parse({ params: req.params }).params;
  const out = await svcArchivePlanningEvent({ id, audit });
  if (out === null) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (out === false) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).send();
});

export const createPlanningEventComment: RequestHandler = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = planningEventIdParamSchema.parse({ params: req.params }).params;
  const body = createPlanningEventCommentSchema.parse({ body: req.body }).body;
  const out = await svcCreatePlanningEventComment({ event_id: id, body, audit });
  res.status(201).json(out);
});

export const uploadPlanningEventDocuments: RequestHandler = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = planningEventIdParamSchema.parse({ params: req.params }).params;
  const documents = getUploadedDocuments(req);
  if (!documents.length) {
    res.status(400).json({ error: "No documents" });
    return;
  }
  const out = await svcUploadPlanningEventDocuments({ event_id: id, documents, audit });
  res.status(201).json({ documents: out });
});

// GET /api/v1/planning/events/:id/documents/:docId/file
export const getPlanningEventDocumentFile: RequestHandler = async (req, res, next) => {
  try {
    const { id, docId } = planningEventDocumentIdParamSchema.parse({ params: req.params }).params;
    const doc = await svcGetPlanningEventDocumentFileMeta({ event_id: id, document_id: docId });
    if (!doc) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const baseDir = path.resolve("uploads/docs");
    const absPath = path.resolve(baseDir, `${doc.id}${safeExtFromName(doc.document_name)}`);
    const basePrefix = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`;
    if (!absPath.startsWith(basePrefix)) {
      throw new HttpError(400, "INVALID_STORAGE_PATH", "Invalid document storage path");
    }

    await fs.access(absPath);

    res.setHeader("Content-Type", resolveMimeType(doc.type));
    const rawDownload = (req.query as { download?: unknown } | undefined)?.download;
    const download = rawDownload === true || rawDownload === "true" || rawDownload === "1" || rawDownload === 1;
    res.setHeader(
      "Content-Disposition",
      `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(doc.document_name)}"`
    );
    res.sendFile(absPath);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      next(new HttpError(404, "FILE_NOT_FOUND", "File not found"));
      return;
    }
    next(err);
  }
};

export const healthPlanning: RequestHandler = asyncHandler(async (_req, res) => {
  res.json({ ok: true });
});
