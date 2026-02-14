import type { Request, RequestHandler } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../../../utils/httpError";
import {
  createCommandeSVC,
  deleteCommandeSVC,
  duplicateCommandeSVC,
  generateAffairesFromOrderSVC,
  getCommandeDocumentFileMetaSVC,
  getCommandeSVC,
  listCommandesSVC,
  updateCommandeSVC,
  updateCommandeStatusSVC,
} from "../services/commande-client.service";
import {
  listCommandesQuerySchema,
  updateCommandeStatusBodySchema,
  type CreateCommandeBodyDTO,
} from "../validators/commande-client.validators";
import type { UploadedDocument } from "../types/commande-client.types";

function getParsedCommandeBody(req: Request): CreateCommandeBodyDTO | null {
  const body = req.parsedCommandeBody;
  if (!body) return null;
  return body as CreateCommandeBodyDTO;
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

function parseIncludeSet(req: Request) {
  const raw = req.query.include;
  const includeStr = Array.isArray(raw) ? raw.join(",") : typeof raw === "string" ? raw : "";
  return new Set(
    includeStr
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
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

// POST /api/v1/commandes (multipart)
export const createCommande: RequestHandler = async (req, res, next) => {
  try {
    const payload = getParsedCommandeBody(req);
    if (!payload) {
      res.status(400).json({ error: "payload manquant" });
      return;
    }

    const documents = getUploadedDocuments(req);
    const out = await createCommandeSVC(payload, documents);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

// PATCH /api/v1/commandes/:id (multipart)
export const updateCommande: RequestHandler = async (req, res, next) => {
  try {
    const payload = getParsedCommandeBody(req);
    if (!payload) {
      res.status(400).json({ error: "payload manquant" });
      return;
    }

    const documents = getUploadedDocuments(req);
    const out = await updateCommandeSVC(req.params.id, payload, documents);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

// GET /api/v1/commandes
export const listCommandes: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listCommandesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" });
      return;
    }
    const out = await listCommandesSVC(parsed.data);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

// GET /api/v1/commandes/:id
export const getCommande: RequestHandler = async (req, res, next) => {
  try {
    const includes = parseIncludeSet(req);
    const out = await getCommandeSVC(req.params.id, includes);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

// DELETE /api/v1/commandes/:id
export const deleteCommande: RequestHandler = async (req, res, next) => {
  try {
    const ok = await deleteCommandeSVC(req.params.id);
    if (!ok) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

// POST /api/v1/commandes/:id/status
export const updateCommandeStatus: RequestHandler = async (req, res, next) => {
  try {
    const parsed = updateCommandeStatusBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid request" });
      return;
    }

    const userId = typeof req.user?.id === "number" ? req.user.id : null;
    const out = await updateCommandeStatusSVC(
      req.params.id,
      parsed.data.nouveau_statut,
      parsed.data.commentaire ?? null,
      userId
    );
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json({ ok: true, ...out });
  } catch (err) {
    next(err);
  }
};

// POST /api/v1/commandes/:id/generate-affaires
export const generateAffairesFromOrder: RequestHandler = async (req, res, next) => {
  try {
    const out = await generateAffairesFromOrderSVC(req.params.id);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

// POST /api/v1/commandes/:id/duplicate
export const duplicateCommande: RequestHandler = async (req, res, next) => {
  try {
    const out = await duplicateCommandeSVC(req.params.id);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

// GET /api/v1/commandes/:id/documents/:docId/file
export const getCommandeDocumentFile: RequestHandler = async (req, res, next) => {
  try {
    const { id, docId } = req.params;
    const doc = await getCommandeDocumentFileMetaSVC(id, docId);
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
