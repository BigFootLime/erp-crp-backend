import type { Request } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";

import type { AuditContext } from "../repository/production.repository";
import {
  cancelExecutionSchema,
  changeExecutionSchema,
  correctExecutionSchema,
  declareQuantitySchema,
  executionCenterQuerySchema,
  executionIdParamSchema,
  finishOperationPreviewSchema,
  finishOperationSchema,
  incidentExecutionSchema,
  listActivityCategoriesQuerySchema,
  listExecutionsQuerySchema,
  operatorBoardQuerySchema,
  pauseExecutionSchema,
  rejectExecutionSchema,
  resumeExecutionSchema,
  startExecutionSchema,
  stopExecutionSchema,
  submitExecutionSchema,
  validateExecutionSchema,
} from "../validators/production-execution.validators";
import {
  svcCancelExecution,
  svcCapabilities,
  svcChangeExecution,
  svcCorrectExecution,
  svcDeclareIncident,
  svcDeclareQuantity,
  svcExecutionCenter,
  svcExecutionIndicators,
  svcFinishOperation,
  svcGetExecution,
  svcListActivityCategories,
  svcListExecutions,
  svcOperatorBoard,
  svcPauseExecution,
  svcPreviewFinishOperation,
  svcRejectExecution,
  svcResumeExecution,
  svcStartExecution,
  svcStopExecution,
  svcSubmitExecution,
  svcValidateExecution,
  type Actor,
} from "../services/production-execution.service";

function requireActor(req: Request): Actor {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  return { id: user.id, role: user.role ?? null };
}

function buildAuditContext(req: Request): AuditContext {
  const actor = requireActor(req);
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const device = parseDevice(userAgent);
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null;
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;

  return {
    user_id: actor.id,
    user_role: actor.role,
    ip: getClientIp(req),
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

/** La garde `requireIdempotencyKey` a déjà validé la présence et la forme. */
function idempotencyKey(req: Request): string {
  return String(req.headers["idempotency-key"]).trim();
}

function executionId(req: Request): string {
  return executionIdParamSchema.parse({ params: req.params }).params.id;
}

/* ------------------------------- Lecture --------------------------------- */

export const listActivityCategories = asyncHandler(async (req, res) => {
  const query = listActivityCategoriesQuerySchema.parse(req.query);
  res.json(await svcListActivityCategories(query));
});

export const capabilities = asyncHandler(async (req, res) => {
  res.json(await svcCapabilities(requireActor(req)));
});

export const listExecutions = asyncHandler(async (req, res) => {
  const query = listExecutionsQuerySchema.parse(req.query);
  res.json(await svcListExecutions(requireActor(req), query));
});

export const getExecution = asyncHandler(async (req, res) => {
  res.json(await svcGetExecution(requireActor(req), executionId(req)));
});

export const executionCenter = asyncHandler(async (req, res) => {
  const query = executionCenterQuerySchema.parse(req.query);
  res.json(await svcExecutionCenter(requireActor(req), query));
});

export const executionIndicators = asyncHandler(async (req, res) => {
  const query = executionCenterQuerySchema.parse(req.query);
  res.json(await svcExecutionIndicators(requireActor(req), query));
});

export const operatorBoard = asyncHandler(async (req, res) => {
  const query = operatorBoardQuerySchema.parse(req.query);
  res.json(await svcOperatorBoard(requireActor(req), query));
});

/* ------------------------------ Commandes -------------------------------- */

export const startExecution = asyncHandler(async (req, res) => {
  const { body } = startExecutionSchema.parse({ body: req.body });
  const created = await svcStartExecution({
    actor: requireActor(req),
    body,
    idempotencyKey: idempotencyKey(req),
    audit: buildAuditContext(req),
  });
  res.status(201).json(created);
});

export const stopExecution = asyncHandler(async (req, res) => {
  const { body } = stopExecutionSchema.parse({ body: req.body });
  res.json(
    await svcStopExecution({
      actor: requireActor(req),
      id: executionId(req),
      body,
      idempotencyKey: idempotencyKey(req),
      audit: buildAuditContext(req),
    })
  );
});

export const pauseExecution = asyncHandler(async (req, res) => {
  const { body } = pauseExecutionSchema.parse({ body: req.body ?? {} });
  res.json(
    await svcPauseExecution({
      actor: requireActor(req),
      id: executionId(req),
      body,
      idempotencyKey: idempotencyKey(req),
      audit: buildAuditContext(req),
    })
  );
});

export const resumeExecution = asyncHandler(async (req, res) => {
  const { body } = resumeExecutionSchema.parse({ body: req.body ?? {} });
  res.json(
    await svcResumeExecution({
      actor: requireActor(req),
      id: executionId(req),
      body,
      idempotencyKey: idempotencyKey(req),
      audit: buildAuditContext(req),
    })
  );
});

export const changeExecution = asyncHandler(async (req, res) => {
  const { body } = changeExecutionSchema.parse({ body: req.body });
  res.json(
    await svcChangeExecution({
      actor: requireActor(req),
      id: executionId(req),
      body,
      idempotencyKey: idempotencyKey(req),
      audit: buildAuditContext(req),
    })
  );
});

export const declareIncident = asyncHandler(async (req, res) => {
  const { body } = incidentExecutionSchema.parse({ body: req.body });
  res.json(
    await svcDeclareIncident({
      actor: requireActor(req),
      id: executionId(req),
      body,
      idempotencyKey: idempotencyKey(req),
      audit: buildAuditContext(req),
    })
  );
});

export const declareQuantity = asyncHandler(async (req, res) => {
  const { body } = declareQuantitySchema.parse({ body: req.body });
  const created = await svcDeclareQuantity({
    actor: requireActor(req),
    body,
    idempotencyKey: idempotencyKey(req),
    audit: buildAuditContext(req),
  });
  res.status(201).json(created);
});

export const previewFinishOperation = asyncHandler(async (req, res) => {
  const { body } = finishOperationPreviewSchema.parse({ body: req.body });
  res.json(await svcPreviewFinishOperation({ actor: requireActor(req), body }));
});

export const finishOperation = asyncHandler(async (req, res) => {
  const { body } = finishOperationSchema.parse({ body: req.body });
  res.json(
    await svcFinishOperation({
      actor: requireActor(req),
      body,
      idempotencyKey: idempotencyKey(req),
      audit: buildAuditContext(req),
    })
  );
});

/* ------------------------- Cycle de validation --------------------------- */

export const submitExecution = asyncHandler(async (req, res) => {
  const { body } = submitExecutionSchema.parse({ body: req.body ?? {} });
  res.json(
    await svcSubmitExecution({
      actor: requireActor(req),
      id: executionId(req),
      body,
      audit: buildAuditContext(req),
    })
  );
});

export const validateExecution = asyncHandler(async (req, res) => {
  const { body } = validateExecutionSchema.parse({ body: req.body ?? {} });
  res.json(
    await svcValidateExecution({
      actor: requireActor(req),
      id: executionId(req),
      body,
      audit: buildAuditContext(req),
    })
  );
});

export const rejectExecution = asyncHandler(async (req, res) => {
  const { body } = rejectExecutionSchema.parse({ body: req.body });
  res.json(
    await svcRejectExecution({
      actor: requireActor(req),
      id: executionId(req),
      body,
      audit: buildAuditContext(req),
    })
  );
});

export const correctExecution = asyncHandler(async (req, res) => {
  const { body } = correctExecutionSchema.parse({ body: req.body });
  res.json(
    await svcCorrectExecution({
      actor: requireActor(req),
      id: executionId(req),
      body,
      audit: buildAuditContext(req),
    })
  );
});

export const cancelExecution = asyncHandler(async (req, res) => {
  const { body } = cancelExecutionSchema.parse({ body: req.body });
  res.json(
    await svcCancelExecution({
      actor: requireActor(req),
      id: executionId(req),
      body,
      audit: buildAuditContext(req),
    })
  );
});
