import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import { stripQueryFromUrl } from "../../../utils/logPath";
import { effectiveRoleHasAny } from "../../auth/domain/roles";
import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { CLIENT_WRITE_ROLES } from "../client.permissions";
import type { AuditContext } from "../repository/client.repository";
import { crmClientIdSchema, crmCommandSchema, crmDetailQuerySchema, crmFollowupQuerySchema, crmIdempotencySchema } from "../validators/client-crm.validators";
import { executeCrmCommand, getClientCrm, getCrmFollowups } from "../services/client-crm.service";

function auditContext(req: Request): AuditContext {
  const id = req.user?.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) throw new HttpError(401, "UNAUTHORIZED", "Connexion requise");
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const device = parseDevice(userAgent);
  const rawSession = req.headers["x-client-session-id"] ?? req.headers["x-session-id"];
  const session = z.string().uuid().safeParse(rawSession);
  return { user_id: id, ip: getClientIp(req), user_agent: userAgent, ...device,
    path: stripQueryFromUrl(req.originalUrl), page_key: "clients.crm",
    client_session_id: session.success ? session.data : null };
}
export const readClientCrm: RequestHandler = async (req, res, next) => {
  try {
    const data = await getClientCrm(crmClientIdSchema.parse(req.params.id), crmDetailQuerySchema.parse(req.query));
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...data, can_write: hasGrantedAccountModuleAccess() || effectiveRoleHasAny(req.user?.role, CLIENT_WRITE_ROLES) });
  } catch (error) { next(error); }
};
export const readCrmFollowups: RequestHandler = async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getCrmFollowups(crmFollowupQuerySchema.parse(req.query)));
  } catch (error) { next(error); }
};
export const postCrmCommand: RequestHandler = async (req, res, next) => {
  try {
    const clientId = crmClientIdSchema.parse(req.params.id);
    const body = crmCommandSchema.parse(req.body);
    const key = crmIdempotencySchema.parse(req.headers["idempotency-key"]);
    const saved = await executeCrmCommand(clientId, body, key, auditContext(req));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Idempotency-Replayed", saved.replayed ? "true" : "false");
    res.status(saved.replayed ? 200 : 201).json(saved.result);
  } catch (error) { next(error); }
};
