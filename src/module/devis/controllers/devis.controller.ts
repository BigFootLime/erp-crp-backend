import type { Request, RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import {
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
  svcListDevis,
  svcUpdateDevis,
} from "../services/devis.service";

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
