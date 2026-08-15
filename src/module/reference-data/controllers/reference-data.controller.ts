import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import {
  applyReferenceDataChangeSetSVC,
  createReferenceDataChangeSetSVC,
  decideReferenceDataChangeSetSVC,
  exportReferenceDataSVC,
  getReferenceDataChangeSetSVC,
  listReferenceDataChangeSetsSVC,
  listReferenceDataRecordsSVC,
  previewReferenceDataChangesSVC,
  readReferenceDataCapabilitiesSVC,
  readReferenceDataCatalogSVC,
} from "../services/reference-data.service";
import type { ReferenceDataAuditContext, ReferenceDatasetCode } from "../types/reference-data.types";
import {
  createReferenceChangeSetSchema,
  referenceApplySchema,
  referenceDecisionSchema,
  referencePreviewSchema,
  validatedQuery,
} from "../validators/reference-data.validators";

function requiredParam(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, "INVALID_ROUTE_PARAM", `Paramètre invalide : ${key}`);
  return value;
}

function auditContext(req: Request): ReferenceDataAuditContext {
  if (typeof req.user?.id !== "number") throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const device = parseDevice(userAgent);
  const rawSession = typeof req.headers["x-client-session-id"] === "string" ? req.headers["x-client-session-id"] : null;
  return {
    user_id: req.user.id,
    role: req.user.role ?? null,
    ip: getClientIp(req),
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    page_key: "reference-data",
    client_session_id: rawSession && /^[0-9a-f-]{36}$/i.test(rawSession) ? rawSession : null,
  };
}

export const readCapabilities: RequestHandler = (req, res) => {
  res.json(readReferenceDataCapabilitiesSVC(req.user?.role));
};

export const readCatalog: RequestHandler = async (_req, res, next) => {
  try { res.json({ datasets: await readReferenceDataCatalogSVC(), generated_at: new Date().toISOString() }); }
  catch (error) { next(error); }
};

export const listRecords: RequestHandler = async (req, res, next) => {
  try {
    const query = validatedQuery<{ limit: number }>(req);
    res.json({ items: await listReferenceDataRecordsSVC(requiredParam(req, "datasetCode") as ReferenceDatasetCode, query.limit) });
  } catch (error) { next(error); }
};

export const previewChanges: RequestHandler = async (req, res, next) => {
  try { res.json(await previewReferenceDataChangesSVC(referencePreviewSchema.parse(req.body))); }
  catch (error) { next(error); }
};

export const createChangeSet: RequestHandler = async (req, res, next) => {
  try {
    const result = await createReferenceDataChangeSetSVC(createReferenceChangeSetSchema.parse(req.body), auditContext(req));
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { next(error); }
};

export const listChangeSets: RequestHandler = async (req, res, next) => {
  try { res.json({ items: await listReferenceDataChangeSetsSVC(validatedQuery(req)) }); }
  catch (error) { next(error); }
};

export const getChangeSet: RequestHandler = async (req, res, next) => {
  try { res.json(await getReferenceDataChangeSetSVC(requiredParam(req, "changeSetId"))); }
  catch (error) { next(error); }
};

export const decideChangeSet: RequestHandler = async (req, res, next) => {
  try {
    res.json(await decideReferenceDataChangeSetSVC(
      requiredParam(req, "changeSetId"), referenceDecisionSchema.parse(req.body), auditContext(req)
    ));
  } catch (error) { next(error); }
};

export const applyChangeSet: RequestHandler = async (req, res, next) => {
  try {
    const body = referenceApplySchema.parse(req.body);
    res.json(await applyReferenceDataChangeSetSVC(requiredParam(req, "changeSetId"), body.idempotency_key, auditContext(req)));
  } catch (error) { next(error); }
};

export const exportReferenceData: RequestHandler = async (req, res, next) => {
  try {
    const query = validatedQuery<{ datasets: ReferenceDatasetCode[] }>(req);
    const payload = await exportReferenceDataSVC(query.datasets);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="cerp-reference-data-${todayForFilename()}.json"`);
    res.json(payload);
  } catch (error) { next(error); }
};

function todayForFilename(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}
