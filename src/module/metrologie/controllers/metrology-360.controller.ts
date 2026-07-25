// Contrôleurs Métrologie 360 (#229).
//
// Chaque handler : valide (Zod strict) → construit le contexte d'acteur →
// délègue au service. Aucune règle métier ici, aucun `storage_path` renvoyé,
// aucune décision prise côté client.

import type { Request, RequestHandler } from "express";
import fs from "node:fs/promises";
import { ZodError, type ZodTypeAny, type z } from "zod";

import { asyncHandler } from "../../../utils/asyncHandler";
import { isPathInsideDirectory, resolveCerpStoragePath } from "../../../utils/cerpStorage";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import { emitEntityChanged } from "../../../shared/realtime/realtime.service";

import type { MetrologyActor } from "../repository/metrology-shared.repository";
import {
  cancelCertificateSchema,
  cancelExecutionSchema,
  centerQuerySchema,
  createEquipmentSchema,
  createExecutionSchema,
  createImpactSchema,
  createPlanSchema,
  decideImpactItemSchema,
  eligibilityQuerySchema,
  equipmentTransitionSchema,
  idParamSchema,
  listCategoriesQuerySchema,
  listEquipmentQuerySchema,
  listExecutionsQuerySchema,
  listImpactItemsQuerySchema,
  listImpactsQuerySchema,
  nestedIdParamSchema,
  planTransitionSchema,
  quarantineSchema,
  recordMeasurementsSchema,
  revisePlanSchema,
  schedulePreviewQuerySchema,
  timelineQuerySchema,
  transitionImpactSchema,
  updateEquipmentSchema,
  uploadCertificateSchema,
  upsertCategorySchema,
  usageQuerySchema,
  validateExecutionSchema,
} from "../validators/metrology-360.validators";
import {
  svcCancelCertificate,
  svcCancelExecution,
  svcCenter,
  svcCreateEquipment,
  svcCreateExecution,
  svcCreateImpact,
  svcCreatePlanVersion,
  svcDecideImpactItem,
  svcEvaluateEligibility,
  svcGetCertificateFile,
  svcGetEquipmentDetail,
  svcGetExecution,
  svcGetImpact,
  svcInstrumentUsage,
  svcListCategories,
  svcListEquipment,
  svcListExecutions,
  svcListImpacts,
  svcListUnits,
  svcMetrologyDocsBaseDir,
  svcPreviewVerdict,
  svcQuarantineEquipment,
  svcRecordMeasurements,
  svcRevisePlanVersion,
  svcSchedulePreview,
  svcTimeline,
  svcTransitionEquipment,
  svcTransitionImpact,
  svcTransitionPlanVersion,
  svcUpdateEquipment,
  svcUploadCertificate,
  svcUpsertCategory,
  svcValidateExecution,
} from "../services/metrology-360.service";

/**
 * Parse strict avec mapping par champ : le frontend peut recoller chaque
 * message sur son input (ADR-0016) au lieu d'afficher une erreur générique.
 * Sans ce garde, une ZodError remonterait en 500 via le gestionnaire global.
 */
function parseOrThrow<S extends ZodTypeAny>(schema: S, payload: unknown): z.infer<S> {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  const error: ZodError = parsed.error;
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path =
      issue.path.filter((segment) => segment !== "body" && segment !== "params").join(".") || "_";
    (fieldErrors[path] ??= []).push(issue.message);
  }
  throw new HttpError(422, "METROLOGY_VALIDATION_ERROR", "Champs invalides.", { fields: fieldErrors });
}

function buildActor(req: Request): MetrologyActor {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const device = parseDevice(userAgent);
  return {
    user_id: user.id,
    role: typeof user.role === "string" ? user.role : null,
    ip: getClientIp(req),
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
    client_session_id:
      typeof req.headers["x-client-session-id"] === "string"
        ? req.headers["x-client-session-id"]
        : typeof req.headers["x-session-id"] === "string"
          ? req.headers["x-session-id"]
          : null,
    request_id: typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : null,
  };
}

function idempotencyKey(req: Request): string | null {
  const raw = req.headers["idempotency-key"];
  return typeof raw === "string" ? raw : null;
}

function notFound(entity: string): never {
  throw new HttpError(404, "NOT_FOUND", `${entity} introuvable.`);
}

function emitChanged(
  req: Request,
  params: { equipementId: string; action: "created" | "updated" | "deleted" | "status_changed" }
) {
  const user = req.user;
  emitEntityChanged({
    entityType: "METROLOGIE_EQUIPEMENT",
    entityId: params.equipementId,
    action: params.action,
    module: "metrologie",
    at: new Date().toISOString(),
    by: {
      id: typeof user?.id === "number" ? user.id : 0,
      name: typeof user?.username === "string" ? user.username : "",
    },
    invalidateKeys: [
      "metrologie:equipements",
      "metrologie:kpis",
      "metrologie:alerts",
      "metrologie:center",
      `metrologie:equipement:${params.equipementId}`,
    ],
  });
}

function firstFile(req: Request): Express.Multer.File | null {
  const single = (req as Request & { file?: Express.Multer.File }).file;
  if (single) return single;
  const files = (req as Request & { files?: unknown }).files;
  if (Array.isArray(files) && files.length > 0) return files[0] as Express.Multer.File;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Référentiels                                                               */
/* -------------------------------------------------------------------------- */

export const listCategories: RequestHandler = asyncHandler(async (req, res) => {
  const query = parseOrThrow(listCategoriesQuerySchema, req.query);
  res.json(await svcListCategories(query));
});

export const upsertCategory: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { body } = parseOrThrow(upsertCategorySchema, { body: req.body });
  const out = await svcUpsertCategory({ body, actor, idempotencyKey: idempotencyKey(req) });
  res.status(200).json(out);
});

export const listUnits: RequestHandler = asyncHandler(async (_req, res) => {
  res.json(svcListUnits());
});

/* -------------------------------------------------------------------------- */
/* Command center et éligibilité                                              */
/* -------------------------------------------------------------------------- */

export const center: RequestHandler = asyncHandler(async (req, res) => {
  const query = parseOrThrow(centerQuerySchema, req.query);
  res.json(
    await svcCenter({
      site: query.site ?? null,
      categorieCode: query.categorie_code ?? null,
      horizonDays: query.horizon_days,
    })
  );
});

export const evaluateEligibility: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const query = parseOrThrow(eligibilityQuerySchema, req.query);
  res.json(await svcEvaluateEligibility({ query, actor }));
});

/* -------------------------------------------------------------------------- */
/* Équipements                                                                */
/* -------------------------------------------------------------------------- */

export const listEquipment: RequestHandler = asyncHandler(async (req, res) => {
  const query = parseOrThrow(listEquipmentQuerySchema, req.query);
  res.json(await svcListEquipment(query));
});

export const getEquipment: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  const out = await svcGetEquipmentDetail({ id: params.id, actor });
  if (!out) notFound("Équipement");
  res.json(out);
});

export const createEquipment: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { body } = parseOrThrow(createEquipmentSchema, { body: req.body });
  const out = await svcCreateEquipment({ body, actor, idempotencyKey: idempotencyKey(req) });
  emitChanged(req, { equipementId: out.equipement.id, action: "created" });
  res.status(201).json(out);
});

export const updateEquipment: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(
    updateEquipmentSchema.extend(idParamSchema.shape),
    { params: req.params, body: req.body }
  );
  const out = await svcUpdateEquipment({ id: params.id, body, actor });
  emitChanged(req, { equipementId: params.id, action: "updated" });
  res.json(out);
});

export const transitionEquipment: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(
    equipmentTransitionSchema.extend(idParamSchema.shape),
    { params: req.params, body: req.body }
  );
  const out = await svcTransitionEquipment({
    id: params.id,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  emitChanged(req, { equipementId: params.id, action: "status_changed" });
  res.json(out);
});

export const quarantineEquipment: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(quarantineSchema.extend(idParamSchema.shape), {
    params: req.params,
    body: req.body,
  });
  const out = await svcQuarantineEquipment({
    id: params.id,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  emitChanged(req, { equipementId: params.id, action: "status_changed" });
  res.json(out);
});

export const equipmentTimeline: RequestHandler = asyncHandler(async (req, res) => {
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  const query = parseOrThrow(timelineQuerySchema, req.query);
  res.json(await svcTimeline({ equipementId: params.id, query }));
});

export const equipmentUsage: RequestHandler = asyncHandler(async (req, res) => {
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  const query = parseOrThrow(usageQuerySchema, req.query);
  res.json(await svcInstrumentUsage({ equipementId: params.id, query }));
});

/* -------------------------------------------------------------------------- */
/* Plans                                                                      */
/* -------------------------------------------------------------------------- */

export const createPlan: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(createPlanSchema, {
    params: req.params,
    body: req.body,
  });
  const out = await svcCreatePlanVersion({
    equipementId: params.id,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  res.status(201).json(out);
});

export const revisePlan: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(revisePlanSchema, {
    params: req.params,
    body: req.body,
  });
  const out = await svcRevisePlanVersion({
    equipementId: params.id,
    planId: params.childId,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  res.json(out);
});

export const transitionPlan: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(planTransitionSchema, {
    params: req.params,
    body: req.body,
  });
  const out = await svcTransitionPlanVersion({
    equipementId: params.id,
    planId: params.childId,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  emitChanged(req, { equipementId: params.id, action: "status_changed" });
  res.json(out);
});

export const schedulePreview: RequestHandler = asyncHandler(async (req, res) => {
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  const query = parseOrThrow(schedulePreviewQuerySchema, req.query);
  res.json(await svcSchedulePreview({ equipementId: params.id, query }));
});

/* -------------------------------------------------------------------------- */
/* Exécutions                                                                 */
/* -------------------------------------------------------------------------- */

export const listExecutions: RequestHandler = asyncHandler(async (req, res) => {
  const query = parseOrThrow(listExecutionsQuerySchema, req.query);
  res.json(await svcListExecutions(query));
});

export const getExecution: RequestHandler = asyncHandler(async (req, res) => {
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  const out = await svcGetExecution(params.id);
  if (!out) notFound("Exécution");
  res.json(out);
});

export const createExecution: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(createExecutionSchema, {
    params: req.params,
    body: req.body,
  });
  const out = await svcCreateExecution({
    equipementId: params.id,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  emitChanged(req, { equipementId: params.id, action: "updated" });
  res.status(201).json(out);
});

export const recordMeasurements: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(recordMeasurementsSchema, {
    params: req.params,
    body: req.body,
  });
  const out = await svcRecordMeasurements({
    executionId: params.id,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  res.json(out);
});

export const previewVerdict: RequestHandler = asyncHandler(async (req, res) => {
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  res.json(await svcPreviewVerdict(params.id));
});

export const validateExecution: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(validateExecutionSchema, {
    params: req.params,
    body: req.body,
  });
  const out = await svcValidateExecution({
    executionId: params.id,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  emitChanged(req, { equipementId: out.execution.equipement_id, action: "status_changed" });
  res.json(out);
});

export const cancelExecution: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(cancelExecutionSchema, {
    params: req.params,
    body: req.body,
  });
  const out = await svcCancelExecution({
    executionId: params.id,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  res.json(out);
});

/* -------------------------------------------------------------------------- */
/* Certificats                                                                */
/* -------------------------------------------------------------------------- */

export const uploadCertificate: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(uploadCertificateSchema, {
    params: req.params,
    body: req.body,
  });
  const out = await svcUploadCertificate({
    equipementId: params.id,
    body,
    file: firstFile(req),
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  emitChanged(req, { equipementId: params.id, action: "updated" });
  res.status(201).json(out);
});

export const cancelCertificate: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(cancelCertificateSchema, {
    params: req.params,
    body: req.body,
  });
  const out = await svcCancelCertificate({
    equipementId: params.id,
    certificateId: params.childId,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  emitChanged(req, { equipementId: params.id, action: "updated" });
  res.json(out);
});

export const downloadCertificate: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params } = parseOrThrow(nestedIdParamSchema, { params: req.params });
  const doc = await svcGetCertificateFile({
    equipementId: params.id,
    certificateId: params.childId,
    actor,
  });

  const baseDir = svcMetrologyDocsBaseDir();
  const absPath = resolveCerpStoragePath(doc.storage_path, baseDir);
  // Défense en profondeur : même si un chemin corrompu franchissait la base, il
  // ne peut pas sortir du répertoire privé des documents.
  if (!isPathInsideDirectory(baseDir, absPath)) {
    throw new HttpError(400, "INVALID_STORAGE_PATH", "Chemin de document invalide.");
  }
  await fs.access(absPath);

  res.setHeader("Content-Type", doc.mime_type ?? "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  const download = req.query.download === "true" || req.query.download === "1";
  const name = doc.file_original_name ?? `certificat-${params.childId}`;
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(name)}"`
  );
  res.sendFile(absPath);
});

/* -------------------------------------------------------------------------- */
/* Analyse d'impact                                                           */
/* -------------------------------------------------------------------------- */

export const listImpacts: RequestHandler = asyncHandler(async (req, res) => {
  const query = parseOrThrow(listImpactsQuerySchema, req.query);
  res.json(await svcListImpacts(query));
});

export const getImpact: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  const itemsQuery = parseOrThrow(listImpactItemsQuerySchema, req.query);
  const out = await svcGetImpact({ id: params.id, actor, itemsQuery });
  if (!out) notFound("Dossier d'impact");
  res.json(out);
});

export const createImpact: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(createImpactSchema, {
    params: req.params,
    body: req.body,
  });
  const out = await svcCreateImpact({
    equipementId: params.id,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  res.status(201).json(out);
});

export const decideImpactItem: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(decideImpactItemSchema, {
    params: req.params,
    body: req.body,
  });
  const out = await svcDecideImpactItem({
    dossierId: params.id,
    itemId: params.childId,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  res.json(out);
});

export const transitionImpact: RequestHandler = asyncHandler(async (req, res) => {
  const actor = buildActor(req);
  const { params, body } = parseOrThrow(transitionImpactSchema, {
    params: req.params,
    body: req.body,
  });
  const out = await svcTransitionImpact({
    id: params.id,
    body,
    actor,
    idempotencyKey: idempotencyKey(req),
  });
  res.json(out);
});
