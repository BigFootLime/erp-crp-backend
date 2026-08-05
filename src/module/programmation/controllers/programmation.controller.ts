import type { Request, RequestHandler } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../../planning/repository/planning.repository";
import {
  cancelProgrammationRescheduleSchema,
  commitProgrammationRescheduleSchema,
  listProgrammationsQuerySchema,
  previewProgrammationRescheduleSchema,
  programmationIdParamSchema,
  programmationRescheduleOperationParamSchema,
} from "../validators/programmation.validators";
import {
  svcCancelProgrammationReschedule,
  svcCommitProgrammationReschedule,
  svcListProgrammations,
  svcPreviewProgrammationReschedule,
} from "../services/programmation.service";

function buildAuditContext(req: Request): AuditContext {
  if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  const forwardedFor = req.headers["x-forwarded-for"];
  const ipFromHeader = typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : null;
  const clientSessionId = typeof req.headers["x-client-session-id"] === "string"
    ? req.headers["x-client-session-id"]
    : typeof req.headers["x-session-id"] === "string"
      ? req.headers["x-session-id"]
      : null;
  return {
    user_id: req.user.id,
    role: req.user.role ?? null,
    ip: ipFromHeader ?? req.ip ?? null,
    user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
    client_session_id: clientSessionId,
  };
}

export const listProgrammations: RequestHandler = asyncHandler(async (req, res) => {
  const query = listProgrammationsQuerySchema.parse(req.query);
  const out = await svcListProgrammations(query);
  res.json(out);
});

export const healthProgrammations: RequestHandler = asyncHandler(async (_req, res) => {
  res.json({ ok: true });
});

export const previewProgrammationReschedule: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = programmationIdParamSchema.parse({ params: req.params }).params;
  const body = previewProgrammationRescheduleSchema.parse({ body: req.body }).body;
  res.json(await svcPreviewProgrammationReschedule({ id, body }));
});

export const commitProgrammationReschedule: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = programmationIdParamSchema.parse({ params: req.params }).params;
  const body = commitProgrammationRescheduleSchema.parse({ body: req.body }).body;
  res.json(await svcCommitProgrammationReschedule({ id, body, audit: buildAuditContext(req) }));
});

export const cancelProgrammationReschedule: RequestHandler = asyncHandler(async (req, res) => {
  const { id, operationId } = programmationRescheduleOperationParamSchema.parse({ params: req.params }).params;
  const body = cancelProgrammationRescheduleSchema.parse({ body: req.body }).body;
  res.json(await svcCancelProgrammationReschedule({ id, operationId, body, audit: buildAuditContext(req) }));
});
