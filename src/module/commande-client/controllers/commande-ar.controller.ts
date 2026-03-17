import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { asyncHandler } from "../../../utils/asyncHandler";
import { generateCommandeArSchema, sendCommandeArSchema } from "../validators/commande-ar.validators";
import { svcGenerateCommandeAr, svcSendCommandeAr } from "../services/commande-ar.service";

function getUserId(req: Request): number {
  const userId = typeof req.user?.id === "number" ? req.user.id : null;
  if (!userId) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  return userId;
}

export const generateCommandeAr: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = generateCommandeArSchema.parse({ params: req.params }).params;
  const out = await svcGenerateCommandeAr({ commande_id: Number(id), user_id: getUserId(req) });
  res.status(201).json(out);
});

export const sendCommandeAr: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = sendCommandeArSchema.parse({ params: req.params, body: req.body });
  const out = await svcSendCommandeAr({
    commande_id: Number(parsed.params.id),
    user_id: getUserId(req),
    body: parsed.body,
  });
  res.status(200).json(out);
});
