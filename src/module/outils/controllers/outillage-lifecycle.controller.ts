import type { NextFunction, Request, RequestHandler, Response } from "express";

import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { HttpError } from "../../../utils/httpError";
import { hasOutillageCapability, type OutillageCapability, type LifecycleEventType } from "../domain/outillage-lifecycle";
import {
  repoCreateToolParameterVersion,
  repoGetTechnicalCompleteness,
  repoGetToolLifecycle,
  repoListAllocations,
  repoListToolRequirements,
  repoReplaceToolRequirements,
  repoReserveTool,
  repoTransitionAllocation,
  type OutillageAuditContext,
} from "../repository/outillage-lifecycle.repository";
import {
  allocationIdParamsSchema,
  createToolParameterVersionSchema,
  lifecycleTransitionSchema,
  listAllocationsSchema,
  replaceToolRequirementsSchema,
  reserveToolSchema,
  technicalVersionParamsSchema,
  toolIdParamsSchema,
} from "../validators/outillage-lifecycle.validators";

function user(req: Request) {
  if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise");
  return req.user;
}

function auditContext(req: Request): OutillageAuditContext {
  const current = user(req);
  const session = req.get("X-Client-Session-Id");
  return {
    user_id: current.id,
    username: current.username,
    ip: req.ip ?? null,
    user_agent: req.get("user-agent") ?? null,
    path: req.originalUrl ?? null,
    page_key: req.get("X-Page-Key") ?? "outils",
    client_session_id: session && session.length <= 200 ? session : null,
    correlation_id: req.requestId ?? null,
  };
}

function idempotencyKey(req: Request): string {
  const key = req.get("Idempotency-Key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key est obligatoire (8 à 128 caractères sûrs)");
  }
  return key;
}

export function requireOutillageCapability(capability: OutillageCapability): RequestHandler {
  return (req, _res, next) => {
    if (hasOutillageCapability(requestHasGrantedAccountModuleAccess(req), req.user?.role, capability)) {
      next();
      return;
    }
    next(new HttpError(403, "OUTILLAGE_CAPABILITY_FORBIDDEN", "Permission outillage insuffisante"));
  };
}

export async function reserveTool(req: Request, res: Response, next: NextFunction) {
  try {
    const body = reserveToolSchema.parse(req.body);
    const result = await repoReserveTool(body, idempotencyKey(req), auditContext(req));
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { next(error); }
}

export async function listAllocations(req: Request, res: Response, next: NextFunction) {
  try {
    const filters = listAllocationsSchema.parse(req.query);
    res.json({ items: await repoListAllocations({ ...filters, open_only: filters.open_only ?? true }) });
  } catch (error) { next(error); }
}

export function transitionAllocation(eventType: LifecycleEventType) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { allocationId } = allocationIdParamsSchema.parse(req.params);
      const body = lifecycleTransitionSchema.parse(req.body);
      res.json(await repoTransitionAllocation(allocationId, eventType, body, idempotencyKey(req), auditContext(req)));
    } catch (error) { next(error); }
  };
}

export async function getToolLifecycle(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = toolIdParamsSchema.parse(req.params);
    res.json(await repoGetToolLifecycle(id));
  } catch (error) { next(error); }
}

export async function createToolParameterVersion(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = toolIdParamsSchema.parse(req.params);
    const body = createToolParameterVersionSchema.parse(req.body);
    res.status(201).json(await repoCreateToolParameterVersion(id, body, auditContext(req)));
  } catch (error) { next(error); }
}

export async function getTechnicalCompleteness(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, versionId } = technicalVersionParamsSchema.parse(req.params);
    res.json(await repoGetTechnicalCompleteness(id, versionId));
  } catch (error) { next(error); }
}

export async function replaceToolRequirements(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, versionId } = technicalVersionParamsSchema.parse(req.params);
    const body = replaceToolRequirementsSchema.parse(req.body);
    res.json(await repoReplaceToolRequirements(id, versionId, body, auditContext(req)));
  } catch (error) { next(error); }
}

export async function listToolRequirements(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, versionId } = technicalVersionParamsSchema.parse(req.params);
    res.json(await repoListToolRequirements(id, versionId));
  } catch (error) { next(error); }
}
