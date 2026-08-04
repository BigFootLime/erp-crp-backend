import type { Request, RequestHandler } from "express";

import { buildContentDisposition } from "../../../shared/uploads/secure-download";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import { stripQueryFromUrl } from "../../../utils/logPath";
import { HttpError } from "../../../utils/httpError";
import * as service from "../services/import-assistant.service";
import {
  confirmImportBatchSchema,
  createImportBatchFieldsSchema,
  importBatchIdSchema,
  listImportBatchesQuerySchema,
  listImportRowsQuerySchema,
  previewImportBatchSchema,
} from "../validators/import-assistant.validators";
import type { ImportAuditContext } from "../types/import-assistant.types";

function auditContext(req: Request): ImportAuditContext {
  if (!req.user || typeof req.user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const device = parseDevice(userAgent);
  return {
    user_id: req.user.id,
    ip: getClientIp(req),
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: stripQueryFromUrl(req.originalUrl),
    page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : "import-assistant",
    client_session_id:
      typeof req.headers["x-client-session-id"] === "string"
        ? req.headers["x-client-session-id"]
        : typeof req.headers["x-session-id"] === "string"
          ? req.headers["x-session-id"]
          : null,
  };
}

function uploadedFile(req: Request): Express.Multer.File {
  if (!req.file) throw new HttpError(400, "IMPORT_FILE_REQUIRED", "Sélectionnez un fichier .xlsx ou .csv.");
  return req.file;
}

export const getCapabilities: RequestHandler = (_req, res) => {
  res.json({ items: service.listImportCapabilities() });
};

export const postBatch: RequestHandler = async (req, res, next) => {
  try {
    const fields = createImportBatchFieldsSchema.parse(req.body);
    const result = await service.createImportBatch({
      ...fields,
      file: uploadedFile(req),
      audit: auditContext(req),
    });
    res.status(result.reused ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
};

export const getBatches: RequestHandler = async (req, res, next) => {
  try {
    const query = listImportBatchesQuerySchema.parse(req.query);
    res.json(await service.listImportBatches(query));
  } catch (error) {
    next(error);
  }
};

export const getBatch: RequestHandler = async (req, res, next) => {
  try {
    const { id } = importBatchIdSchema.parse(req.params);
    res.json(await service.getImportBatch(id));
  } catch (error) {
    next(error);
  }
};

export const getBatchRows: RequestHandler = async (req, res, next) => {
  try {
    const { id } = importBatchIdSchema.parse(req.params);
    const query = listImportRowsQuerySchema.parse(req.query);
    res.json(await service.listImportRows({ id, ...query }));
  } catch (error) {
    next(error);
  }
};

export const putBatchPreview: RequestHandler = async (req, res, next) => {
  try {
    const { id } = importBatchIdSchema.parse(req.params);
    const mapping = previewImportBatchSchema.parse(req.body);
    res.json(await service.previewImportBatch({ id, mapping, audit: auditContext(req) }));
  } catch (error) {
    next(error);
  }
};

export const postBatchConfirm: RequestHandler = async (req, res, next) => {
  try {
    const { id } = importBatchIdSchema.parse(req.params);
    const body = confirmImportBatchSchema.parse(req.body);
    const rawKey = req.headers["idempotency-key"];
    const idempotencyKey = typeof rawKey === "string" ? rawKey.trim() : "";
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Une clé Idempotency-Key stable de 8 à 200 caractères est requise.");
    }
    const result = await service.confirmImportBatch({
      id,
      expected_preview_hash: body.expected_preview_hash,
      idempotency_key: idempotencyKey,
      audit: auditContext(req),
    });
    res.status(result.replayed ? 200 : 202).json(result.response);
  } catch (error) {
    next(error);
  }
};

export const getBatchReport: RequestHandler = async (req, res, next) => {
  try {
    const { id } = importBatchIdSchema.parse(req.params);
    const report = await service.buildImportReportCsv(id);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", buildContentDisposition(report.filename, true));
    res.send(report.csv);
  } catch (error) {
    next(error);
  }
};
