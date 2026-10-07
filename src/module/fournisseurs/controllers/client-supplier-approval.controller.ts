import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import {
  approvalRevisionInputSchema,
  approvalScopeSchema,
} from "../domain/client-supplier-approval";
import {
  appendClientApproval,
  clientApprovalHistory,
  listClientApprovalEvidence,
  listClientApprovals,
} from "../services/client-supplier-approval.service";
const querySchema = z
  .object({ client_id: approvalScopeSchema.shape.client_id })
  .strict();
function actor(req: Request) {
  if (!req.user?.id)
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return req.user.id;
}
export const readClientApprovals: RequestHandler = async (req, res, next) => {
  try {
    const query = querySchema.parse(req.query);
    res.json({ data: await listClientApprovals(actor(req), query.client_id) });
  } catch (error) {
    next(error);
  }
};
export const readClientApprovalEvidence: RequestHandler = async (
  req,
  res,
  next,
) => {
  try {
    const query = querySchema.parse(req.query);
    res.json({
      data: await listClientApprovalEvidence(actor(req), query.client_id),
    });
  } catch (error) {
    next(error);
  }
};
export const createClientApprovalRevision: RequestHandler = async (
  req,
  res,
  next,
) => {
  try {
    res
      .status(201)
      .json({
        data: await appendClientApproval(
          actor(req),
          approvalRevisionInputSchema.parse(req.body),
        ),
      });
  } catch (error) {
    next(error);
  }
};
export const readClientApprovalHistory: RequestHandler = async (
  req,
  res,
  next,
) => {
  try {
    res.json({
      data: await clientApprovalHistory(
        actor(req),
        z.string().uuid().parse(req.params.scopeId),
      ),
    });
  } catch (error) {
    next(error);
  }
};
