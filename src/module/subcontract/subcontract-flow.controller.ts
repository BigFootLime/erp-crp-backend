import type { RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { buildAuditContext } from "../planning/controllers/planning.controller";
import {
  getSubcontractFlow,
  getSubcontractCreationOptions,
  transferSubcontractReturn,
} from "./subcontract-flow.service";
import { subcontractTransferSchema } from "./subcontract-flow.validators";
export const getFlow: RequestHandler = asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await getSubcontractFlow(z.string().uuid().parse(req.params.id)));
});
export const getCreationOptions: RequestHandler = asyncHandler(
  async (req, res) => {
    const query = z
      .object({
        of_id: z.coerce.number().int().positive().optional(),
        line_id: z.string().uuid().optional(),
      })
      .refine(
        (q) => q.of_id !== undefined || q.line_id !== undefined,
        "Un OF ou une ligne fournisseur est obligatoire.",
      )
      .parse(req.query);
    res.setHeader("Cache-Control", "no-store");
    res.json(await getSubcontractCreationOptions(query.of_id, query.line_id));
  },
);
export const postTransfer: RequestHandler = asyncHandler(async (req, res) => {
  res.json(
    await transferSubcontractReturn(
      z.string().uuid().parse(req.params.id),
      subcontractTransferSchema.parse(req.body),
      buildAuditContext(req),
      req.header("Idempotency-Key") ?? "",
    ),
  );
});
