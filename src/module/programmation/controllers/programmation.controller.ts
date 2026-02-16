import type { RequestHandler } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import { listProgrammationsQuerySchema } from "../validators/programmation.validators";
import { svcListProgrammations } from "../services/programmation.service";

export const listProgrammations: RequestHandler = asyncHandler(async (req, res) => {
  const query = listProgrammationsQuerySchema.parse(req.query);
  const out = await svcListProgrammations(query);
  res.json(out);
});

export const healthProgrammations: RequestHandler = asyncHandler(async (_req, res) => {
  res.json({ ok: true });
});
