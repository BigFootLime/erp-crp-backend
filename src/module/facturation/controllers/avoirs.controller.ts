import type { RequestHandler } from "express";
import fs from "node:fs/promises";
import { getDocumentStoragePath } from "../../../utils/cerpStorage";
import { sendSecureStoredFile } from "../../../shared/uploads/secure-download";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { readLatestFinanceLegalArchive } from "../services/finance-legal-archive.service";
import {
  avoirIdParamsSchema,
  createAvoirBodySchema,
  getAvoirQuerySchema,
  listAvoirsQuerySchema,
  updateAvoirBodySchema,
} from "../validators/avoirs.validators";
import { svcCreateAvoir, svcDeleteAvoir, svcGetAvoir, svcListAvoirs, svcUpdateAvoir } from "../services/avoirs.service";
import {
  svcGenerateAvoirPdf,
  svcGetDocumentName,
  svcGetLatestAvoirPdfDocumentId,
  svcGetPdfFilePath,
} from "../services/pdf.service";

function coerceBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes" || v === "y";
  }
  return false;
}

export const listAvoirs: RequestHandler = async (req, res, next) => {
  try {
    const query = listAvoirsQuerySchema.parse(req.query);
    const out = await svcListAvoirs(query);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getAvoir: RequestHandler = async (req, res, next) => {
  try {
    const { id } = avoirIdParamsSchema.parse(req.params);
    const { include } = getAvoirQuerySchema.parse(req.query);
    const out = await svcGetAvoir(id, include);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const createAvoir: RequestHandler = async (req, res, next) => {
  try {
    const dto = createAvoirBodySchema.parse(req.body);
    const out = await svcCreateAvoir(dto);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const updateAvoir: RequestHandler = async (req, res, next) => {
  try {
    const { id } = avoirIdParamsSchema.parse(req.params);
    const dto = updateAvoirBodySchema.parse(req.body);
    if (Object.keys(dto).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }
    const out = await svcUpdateAvoir(id, dto);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

export const deleteAvoir: RequestHandler = async (req, res, next) => {
  try {
    const { id } = avoirIdParamsSchema.parse(req.params);
    const ok = await svcDeleteAvoir(id);
    if (!ok) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

export const generateAvoirPdf: RequestHandler = async (req, res, next) => {
  try {
    const { id } = avoirIdParamsSchema.parse(req.params);
    const out = await svcGenerateAvoirPdf(id);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const getAvoirPdf: RequestHandler = async (req, res, next) => {
  try {
    const { id } = avoirIdParamsSchema.parse(req.params);
    const download = coerceBool((req.query as { download?: unknown } | undefined)?.download);

    const issued = await pool.query<{ statut: string }>(`SELECT statut FROM public.avoir WHERE id = $1`, [id]);
    if (issued.rows[0]?.statut === "ISSUED") {
      const actorId = req.user?.id;
      if (typeof actorId !== "number") throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
      const official = await readLatestFinanceLegalArchive("AVOIR", id, actorId, download ? "AUTHORITATIVE_PDF_DOWNLOADED" : "AUTHORITATIVE_PDF_PREVIEWED");
      res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Length", String(official.bytes.byteLength));
      res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename=\"${official.filename.replace(/[\\\"\r\n]/g, "_")}\"`);
      res.send(official.bytes); return;
    }

    let documentId = await svcGetLatestAvoirPdfDocumentId(id);
    if (!documentId) {
      const created = await svcGenerateAvoirPdf(id);
      documentId = created.document_id;
    }

    let filePath = await svcGetPdfFilePath(documentId);
    try {
      await fs.stat(filePath);
    } catch {
      const regenerated = await svcGenerateAvoirPdf(id);
      documentId = regenerated.document_id;
      filePath = await svcGetPdfFilePath(documentId);
    }

    const docName = (await svcGetDocumentName(documentId)) ?? `avoir-${id}.pdf`;
    await sendSecureStoredFile(res, {
      filePath,
      allowedRoots: [getDocumentStoragePath()],
      filename: docName,
      mimeType: "application/pdf",
      download,
    });
  } catch (err) {
    next(err);
  }
};
