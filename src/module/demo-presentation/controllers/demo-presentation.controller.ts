import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { presentationRunSchema } from "../validators/demo-presentation.validators";
import { runPresentation } from "../services/demo-presentation.service";

function idempotencyKey(req: Parameters<RequestHandler>[0]): string {
  const value = req.headers["idempotency-key"];
  if (typeof value !== "string" || value.trim().length < 8 || value.trim().length > 200) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Une clé d'idempotence de 8 à 200 caractères est requise.");
  }
  return value.trim();
}

export const runDemoPresentation: RequestHandler = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user || typeof user.id !== "number") throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
    const requestKey = idempotencyKey(req);
    const input = presentationRunSchema.parse(req.body);
    const forwardedFor = req.headers["x-forwarded-for"];
    const ip = typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : req.ip ?? null;
    const out = await runPresentation({
      action: input.action,
      scenarioId: input.scenario_id,
      clientId: input.client_id,
      devisId: input.devis_id,
      requestKey,
      actor: { id: user.id, role: user.role },
      context: {
        ip,
        user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
        path: req.originalUrl ?? null,
        page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
        client_session_id: typeof req.headers["x-client-session-id"] === "string" ? req.headers["x-client-session-id"] : null,
      },
    });
    res.status(200).json(out);
  } catch (error) {
    next(error);
  }
};
