import type { RequestHandler } from "express";
import fs from "node:fs/promises";
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
    const disposition = download ? "attachment" : "inline";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${disposition}; filename="${docName.replace(/\"/g, "")}"`);
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
};
