import type { RequestHandler } from "express";
import fs from "node:fs/promises";
import {
  createFactureBodySchema,
  factureIdParamsSchema,
  getFactureQuerySchema,
  listFacturesQuerySchema,
  updateFactureBodySchema,
} from "../validators/factures.validators";
import {
  svcCreateFacture,
  svcDeleteFacture,
  svcGetFacture,
  svcListFactures,
  svcUpdateFacture,
} from "../services/factures.service";
import {
  svcGenerateFacturePdf,
  svcGetDocumentName,
  svcGetLatestFacturePdfDocumentId,
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

export const listFactures: RequestHandler = async (req, res, next) => {
  try {
    const query = listFacturesQuerySchema.parse(req.query);
    const out = await svcListFactures(query);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getFacture: RequestHandler = async (req, res, next) => {
  try {
    const { id } = factureIdParamsSchema.parse(req.params);
    const { include } = getFactureQuerySchema.parse(req.query);
    const out = await svcGetFacture(id, include);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const createFacture: RequestHandler = async (req, res, next) => {
  try {
    const dto = createFactureBodySchema.parse(req.body);
    const out = await svcCreateFacture(dto);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const updateFacture: RequestHandler = async (req, res, next) => {
  try {
    const { id } = factureIdParamsSchema.parse(req.params);
    const dto = updateFactureBodySchema.parse(req.body);
    if (Object.keys(dto).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }
    const out = await svcUpdateFacture(id, dto);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

export const deleteFacture: RequestHandler = async (req, res, next) => {
  try {
    const { id } = factureIdParamsSchema.parse(req.params);
    const ok = await svcDeleteFacture(id);
    if (!ok) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

export const generateFacturePdf: RequestHandler = async (req, res, next) => {
  try {
    const { id } = factureIdParamsSchema.parse(req.params);
    const out = await svcGenerateFacturePdf(id);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const getFacturePdf: RequestHandler = async (req, res, next) => {
  try {
    const { id } = factureIdParamsSchema.parse(req.params);
    const download = coerceBool((req.query as { download?: unknown } | undefined)?.download);

    let documentId = await svcGetLatestFacturePdfDocumentId(id);
    if (!documentId) {
      const created = await svcGenerateFacturePdf(id);
      documentId = created.document_id;
    }

    let filePath = await svcGetPdfFilePath(documentId);
    try {
      await fs.stat(filePath);
    } catch {
      const regenerated = await svcGenerateFacturePdf(id);
      documentId = regenerated.document_id;
      filePath = await svcGetPdfFilePath(documentId);
    }

    const docName = (await svcGetDocumentName(documentId)) ?? `facture-${id}.pdf`;
    const disposition = download ? "attachment" : "inline";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${disposition}; filename="${docName.replace(/\"/g, "")}"`);
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
};
