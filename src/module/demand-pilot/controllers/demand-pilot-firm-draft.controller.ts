import type { RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { idempotencyKeySchema } from "../validators/demand-pilot.validators";
import { firmDraftSchema } from "../validators/demand-pilot-firm-draft.validators";
import { prepareFirmDraft as prepare } from "../services/demand-pilot-firm-draft.service";
export const prepareFirmDraft: RequestHandler = async (req, res, next) => {
  try {
    if (typeof req.user?.id !== "number")
      throw new HttpError(401, "UNAUTHORIZED", "Connexion requise.");
    const key = idempotencyKeySchema.safeParse(req.header("Idempotency-Key"));
    if (!key.success)
      throw new HttpError(
        400,
        "DEMAND_FIRM_DRAFT_IDEMPOTENCY_REQUIRED",
        "Un en-tête Idempotency-Key UUID est requis.",
      );
    const out = await prepare(
      firmDraftSchema.parse(req.body),
      req.user.id,
      key.data,
    );
    res
      .status(out.replayed ? 200 : 201)
      .setHeader("Idempotency-Replayed", String(out.replayed))
      .json({ data: out });
  } catch (e) {
    next(e);
  }
};
