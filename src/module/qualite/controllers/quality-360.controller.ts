// Contrôleurs Qualité 360 (#228).
//
// Chaque handler : valide (Zod strict) → construit le contexte d'acteur →
// délègue au service. Aucune règle métier ici, aucun `storage_path` renvoyé,
// aucune décision prise côté client.

import type { Request, RequestHandler } from "express";
import { ZodError, type ZodTypeAny, type z } from "zod";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";

import type { QualityActor } from "../repository/quality-360.repository";
import {
  consumeDerogationSchema,
  createDeliveryPolicySchema,
  createDerogationSchema,
  createExecutionSchema,
  createPlanSchema,
  decideExecutionSchema,
  deliveryPolicyTransitionSchema,
  derogationTransitionSchema,
  eligibilityQuerySchema,
  executionPreviewSchema,
  idParamSchema,
  listDerogationsQuerySchema,
  listExecutionsQuerySchema,
  listPlansQuerySchema,
  ncTransitionSchema,
  planApplicabilityQuerySchema,
  planTransitionSchema,
  qualityCenterQuerySchema,
  recordMeasurementsSchema,
  reviseDeliveryPolicySchema,
  revisePlanSchema,
  updatePlanSchema,
  updateDeliveryPolicySchema,
  upsertAnalysisSchema,
} from "../validators/quality-360.validators";
import {
  svcConsumeDerogation,
  svcCreateDeliveryPolicy,
  svcCreateDerogation,
  svcCreateExecution,
  svcCreatePlan,
  svcDecideExecution,
  svcEvaluateEligibility,
  svcGetDeliveryPolicy,
  svcGetDerogation,
  svcGetExecution,
  svcGetNcAnalysis,
  svcGetPlan,
  svcListDerogations,
  svcListDeliveryPolicies,
  svcListExecutions,
  svcListPlans,
  svcPlanApplicability,
  svcPreviewExecution,
  svcPreviewVerdict,
  svcQualityCenter,
  svcRecordMeasurements,
  svcReviseDeliveryPolicy,
  svcRevisePlan,
  svcTransitionDerogation,
  svcTransitionDeliveryPolicy,
  svcTransitionNc,
  svcTransitionPlan,
  svcUpdatePlan,
  svcUpdateDeliveryPolicy,
  svcUpsertNcAnalysis,
} from "../services/quality-360.service";

/* -------------------------------------------------------------------------- */
/* Politique globale de liberation des BL                                     */
/* -------------------------------------------------------------------------- */

export const listDeliveryPolicies: RequestHandler = asyncHandler(async (_req, res) => {
  const items = await svcListDeliveryPolicies();
  res.json({ items, total: items.length });
});

export const getDeliveryPolicy: RequestHandler = asyncHandler(async (req, res) => {
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  const out = await svcGetDeliveryPolicy(params.id);
  if (!out) notFound("Politique de liberation");
  res.json(out);
});

export const createDeliveryPolicy: RequestHandler = asyncHandler(async (req, res) => {
  const { body } = parseOrThrow(createDeliveryPolicySchema, { body: req.body });
  const out = await svcCreateDeliveryPolicy({ body, actor: buildActor(req), idempotencyKey: idempotencyKey(req) });
  res.status(201).json(out);
});

export const updateDeliveryPolicy: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = parseOrThrow(updateDeliveryPolicySchema, { params: req.params, body: req.body });
  const out = await svcUpdateDeliveryPolicy({ id: parsed.params.id, body: parsed.body, actor: buildActor(req) });
  if (!out) notFound("Politique de liberation");
  res.json(out);
});

export const transitionDeliveryPolicy: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = parseOrThrow(deliveryPolicyTransitionSchema, { params: req.params, body: req.body });
  const out = await svcTransitionDeliveryPolicy({
    id: parsed.params.id,
    body: parsed.body,
    actor: buildActor(req),
    idempotencyKey: idempotencyKey(req),
  });
  if (!out) notFound("Politique de liberation");
  res.json(out);
});

export const reviseDeliveryPolicy: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = parseOrThrow(reviseDeliveryPolicySchema, { params: req.params, body: req.body });
  const out = await svcReviseDeliveryPolicy({
    id: parsed.params.id,
    revisionReason: parsed.body.revision_reason,
    actor: buildActor(req),
    idempotencyKey: idempotencyKey(req),
  });
  if (!out) notFound("Politique de liberation");
  res.status(201).json(out);
});

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
    const path = issue.path.filter((segment) => segment !== "body" && segment !== "params").join(".") || "_";
    (fieldErrors[path] ??= []).push(issue.message);
  }
  throw new HttpError(422, "QUALITY_VALIDATION_ERROR", "Champs invalides.", { fields: fieldErrors });
}

function buildActor(req: Request): QualityActor {
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

/* -------------------------------------------------------------------------- */
/* Plans                                                                      */
/* -------------------------------------------------------------------------- */

export const listPlans: RequestHandler = asyncHandler(async (req, res) => {
  const filters = parseOrThrow(listPlansQuerySchema, req.query);
  const out = await svcListPlans(filters);
  res.json({ items: out.items, total: out.total, page: filters.page, pageSize: filters.pageSize });
});

export const getPlan: RequestHandler = asyncHandler(async (req, res) => {
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  const out = await svcGetPlan(params.id);
  if (!out) notFound("Plan de contrôle");
  res.json(out);
});

export const createPlan: RequestHandler = asyncHandler(async (req, res) => {
  const { body } = parseOrThrow(createPlanSchema, { body: req.body });
  const out = await svcCreatePlan({
    body,
    actor: buildActor(req),
    idempotencyKey: idempotencyKey(req),
  });
  res.status(201).json(out);
});

export const updatePlan: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = parseOrThrow(updatePlanSchema, { params: req.params, body: req.body });
  const out = await svcUpdatePlan({ id: parsed.params.id, body: parsed.body, actor: buildActor(req) });
  if (!out) notFound("Plan de contrôle");
  res.json(out);
});

export const transitionPlan: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = parseOrThrow(planTransitionSchema, { params: req.params, body: req.body });
  const out = await svcTransitionPlan({
    id: parsed.params.id,
    body: parsed.body,
    actor: buildActor(req),
  });
  if (!out) notFound("Plan de contrôle");
  res.json(out);
});

export const revisePlan: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = parseOrThrow(revisePlanSchema, { params: req.params, body: req.body });
  const out = await svcRevisePlan({
    id: parsed.params.id,
    revisionReason: parsed.body.revision_reason,
    actor: buildActor(req),
  });
  if (!out) notFound("Plan de contrôle");
  res.status(201).json(out);
});

export const planApplicability: RequestHandler = asyncHandler(async (req, res) => {
  const query = parseOrThrow(planApplicabilityQuerySchema, req.query);
  res.json(await svcPlanApplicability(query));
});

/* -------------------------------------------------------------------------- */
/* Exécutions                                                                 */
/* -------------------------------------------------------------------------- */

export const listExecutions: RequestHandler = asyncHandler(async (req, res) => {
  const filters = parseOrThrow(listExecutionsQuerySchema, req.query);
  const out = await svcListExecutions(filters);
  res.json({ items: out.items, total: out.total, page: filters.page, pageSize: filters.pageSize });
});

export const getExecution: RequestHandler = asyncHandler(async (req, res) => {
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  const out = await svcGetExecution(params.id);
  if (!out) notFound("Contrôle");
  res.json(out);
});

export const previewExecution: RequestHandler = asyncHandler(async (req, res) => {
  const { body } = parseOrThrow(executionPreviewSchema, { body: req.body });
  res.json(await svcPreviewExecution(body));
});

export const createExecution: RequestHandler = asyncHandler(async (req, res) => {
  const { body } = parseOrThrow(createExecutionSchema, { body: req.body });
  const out = await svcCreateExecution({
    body,
    actor: buildActor(req),
    idempotencyKey: idempotencyKey(req),
  });
  res.status(201).json(out);
});

export const recordMeasurements: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = parseOrThrow(recordMeasurementsSchema, { params: req.params, body: req.body });
  const out = await svcRecordMeasurements({
    id: parsed.params.id,
    body: parsed.body,
    actor: buildActor(req),
  });
  if (!out) notFound("Contrôle");
  res.json(out);
});

export const previewVerdict: RequestHandler = asyncHandler(async (req, res) => {
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  const out = await svcPreviewVerdict(params.id);
  if (!out) notFound("Contrôle");
  res.json(out);
});

export const decideExecution: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = parseOrThrow(decideExecutionSchema, { params: req.params, body: req.body });
  const out = await svcDecideExecution({
    id: parsed.params.id,
    body: parsed.body,
    actor: buildActor(req),
    idempotencyKey: idempotencyKey(req),
  });
  if (!out) notFound("Contrôle");
  res.json(out);
});

/* -------------------------------------------------------------------------- */
/* Dérogations                                                                */
/* -------------------------------------------------------------------------- */

export const listDerogations: RequestHandler = asyncHandler(async (req, res) => {
  const filters = parseOrThrow(listDerogationsQuerySchema, req.query);
  const out = await svcListDerogations(filters);
  res.json({ items: out.items, total: out.total, page: filters.page, pageSize: filters.pageSize });
});

export const getDerogation: RequestHandler = asyncHandler(async (req, res) => {
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  const out = await svcGetDerogation(params.id);
  if (!out) notFound("Dérogation");
  res.json(out);
});

export const createDerogation: RequestHandler = asyncHandler(async (req, res) => {
  const { body } = parseOrThrow(createDerogationSchema, { body: req.body });
  res.status(201).json(await svcCreateDerogation({ body, actor: buildActor(req) }));
});

export const transitionDerogation: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = parseOrThrow(derogationTransitionSchema, { params: req.params, body: req.body });
  const out = await svcTransitionDerogation({
    id: parsed.params.id,
    body: parsed.body,
    actor: buildActor(req),
  });
  if (!out) notFound("Dérogation");
  res.json(out);
});

export const consumeDerogation: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = parseOrThrow(consumeDerogationSchema, { params: req.params, body: req.body });
  const out = await svcConsumeDerogation({
    id: parsed.params.id,
    body: parsed.body,
    actor: buildActor(req),
    idempotencyKey: idempotencyKey(req),
  });
  if (!out) notFound("Dérogation");
  res.status(201).json(out);
});

/* -------------------------------------------------------------------------- */
/* Non-conformités : analyse guidée et transitions                             */
/* -------------------------------------------------------------------------- */

export const getNcAnalysis: RequestHandler = asyncHandler(async (req, res) => {
  const { params } = parseOrThrow(idParamSchema, { params: req.params });
  res.json({ steps: await svcGetNcAnalysis(params.id) });
});

export const upsertNcAnalysis: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = parseOrThrow(upsertAnalysisSchema, { params: req.params, body: req.body });
  const out = await svcUpsertNcAnalysis({
    id: parsed.params.id,
    body: parsed.body,
    actor: buildActor(req),
  });
  if (!out) notFound("Non-conformité");
  res.json(out);
});

export const transitionNc: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = parseOrThrow(ncTransitionSchema, { params: req.params, body: req.body });
  const out = await svcTransitionNc({
    id: parsed.params.id,
    body: parsed.body,
    actor: buildActor(req),
  });
  if (!out) notFound("Non-conformité");
  res.json(out);
});

/* -------------------------------------------------------------------------- */
/* Éligibilité et centre Qualité                                              */
/* -------------------------------------------------------------------------- */

export const evaluateEligibility: RequestHandler = asyncHandler(async (req, res) => {
  const query = parseOrThrow(eligibilityQuerySchema, req.query);
  res.json(await svcEvaluateEligibility(query));
});

export const qualityCenter: RequestHandler = asyncHandler(async (req, res) => {
  const query = parseOrThrow(qualityCenterQuerySchema, req.query);
  res.json(await svcQualityCenter({ horizonDays: query.horizon_days }));
});
