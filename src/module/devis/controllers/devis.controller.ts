import type { Request, RequestHandler } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../../../utils/httpError";
import {
  devisDocumentIdParamsSchema,
  devisIdParamsSchema,
  getDevisQuerySchema,
  listDevisQuerySchema,
  type CreateDevisBodyDTO,
  type UpdateDevisBodyDTO,
} from "../validators/devis.validators";
import type { UploadedDocument } from "../types/devis.types";
import {
  svcConvertDevisToCommande,
  svcCreateDevis,
  svcDeleteDevis,
  svcGetDevis,
  svcGetDevisDocumentFileMeta,
  svcListDevis,
  svcUpdateDevis,
} from "../services/devis.service";

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

function getParsedDevisBody(req: Request): CreateDevisBodyDTO | UpdateDevisBodyDTO | null {
  const body = req.parsedDevisBody;
  if (!body) return null;
  return body as CreateDevisBodyDTO | UpdateDevisBodyDTO;
}

function getUploadedDocuments(req: Request): UploadedDocument[] {
  const filesValue = (req as unknown as { files?: unknown }).files;
  const files = Array.isArray(filesValue) ? (filesValue as Express.Multer.File[]) : [];
  return files.map((f) => ({
    originalname: f.originalname,
    path: f.path,
    mimetype: f.mimetype,
  }));
}

export const listDevis: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listDevisQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const out = await svcListDevis(parsed.data);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getDevis: RequestHandler = async (req, res, next) => {
  try {
    const { id } = devisIdParamsSchema.parse(req.params);
    const { include } = getDevisQuerySchema.parse(req.query);
    const out = await svcGetDevis(id, include);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const createDevis: RequestHandler = async (req, res, next) => {
  try {
    const dto = getParsedDevisBody(req);
    if (!dto) throw new HttpError(400, "MISSING_DATA", "Missing data field");

    const userId = typeof dto.user_id === "number" ? dto.user_id : typeof req.user?.id === "number" ? req.user.id : null;
    if (!userId) throw new HttpError(422, "USER_ID_REQUIRED", "user_id is required");

    const documents = getUploadedDocuments(req);
    const out = await svcCreateDevis(dto as CreateDevisBodyDTO, userId, documents);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const updateDevis: RequestHandler = async (req, res, next) => {
  try {
    const { id } = devisIdParamsSchema.parse(req.params);
    const dto = getParsedDevisBody(req);
    if (!dto) throw new HttpError(400, "MISSING_DATA", "Missing data field");

    const userId = typeof dto.user_id === "number" ? dto.user_id : typeof req.user?.id === "number" ? req.user.id : null;
    if (!userId) throw new HttpError(422, "USER_ID_REQUIRED", "user_id is required");

    const documents = getUploadedDocuments(req);
    const out = await svcUpdateDevis(id, dto as UpdateDevisBodyDTO, userId, documents);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

export const deleteDevis: RequestHandler = async (req, res, next) => {
  try {
    const { id } = devisIdParamsSchema.parse(req.params);
    const ok = await svcDeleteDevis(id);
    if (!ok) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

export const convertDevisToCommande: RequestHandler = async (req, res, next) => {
  try {
    const { id } = devisIdParamsSchema.parse(req.params);
    const out = await svcConvertDevisToCommande(id);
    if (!out) throw new HttpError(404, "DEVIS_NOT_FOUND", "Devis not found");
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

// GET /api/v1/devis/:id/documents/:docId/file
export const getDevisDocumentFile: RequestHandler = async (req, res, next) => {
  try {
    const { id, docId } = devisDocumentIdParamsSchema.parse(req.params);
    const doc = await svcGetDevisDocumentFileMeta(id, docId);
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
