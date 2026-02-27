import type { Request, RequestHandler } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import {
  confirmQuickCommandeSchema,
  previewQuickCommandeSchema,
} from "../validators/quick-commande.validators";
import { svcConfirmQuickCommande, svcPreviewQuickCommande } from "../services/quick-commande.service";

type AuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

function buildAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");

  const forwardedFor = req.headers["x-forwarded-for"];
  const ipFromHeader = typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : null;
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null;
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;

  return {
    user_id: user.id,
    ip: ipFromHeader ?? req.ip ?? null,
    user_agent: ua,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

export const healthQuickCommande: RequestHandler = asyncHandler(async (_req, res) => {
  res.json({ ok: true });
});

export const previewQuickCommande: RequestHandler = asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");

  const body = previewQuickCommandeSchema.parse({ body: req.body }).body;
  const out = await svcPreviewQuickCommande({ body, user_id: user.id });
  res.json(out);
});

export const confirmQuickCommande: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const body = confirmQuickCommandeSchema.parse({ body: req.body }).body;
    const rawIdempotencyKey = req.get("Idempotency-Key");
    const idempotencyKey = typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim().length > 0
      ? rawIdempotencyKey.trim()
      : null;

    const out = await svcConfirmQuickCommande({ body, idempotency_key: idempotencyKey, audit });
    res.json(out);
  } catch (err) {
    if (err instanceof HttpError && err.code === "PLANNING_CONFLICT") {
      res.status(err.status).json({
        success: false,
        message: err.message,
        code: err.code,
        path: req.originalUrl,
        details: err.details ?? null,
      });
      return;
    }
    next(err);
  }
};
