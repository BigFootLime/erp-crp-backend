import type { Request, RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import { deliveryPrepaymentTermsBodySchema, proformaAllocationParamsSchema, proformaCreateBodySchema,
  proformaDraftBodySchema, proformaIdParamsSchema, proformaIssueBodySchema, proformaListQuerySchema,
  proformaRefreshBodySchema, proformaCancelBodySchema, proformaReceiptAssignmentBodySchema,
  proformaReceiptReleaseBodySchema, proformaReceiptReleaseParamsSchema } from "../validators/proforma.validators";
import { svcCreateProforma, svcDecideDeliveryPrepaymentTerms, svcGetProforma, svcIssueProforma,
  svcListProformas, svcPreviewExistingProforma, svcPreviewProforma,
  svcPreviewProformaChanges, svcRefreshProforma, svcCancelProforma, svcAssignProformaReceipts, svcReleaseProformaReceipt } from "../services/proforma.service";

function context(req: Request): { actor: FinanceActorContext; idempotencyKey: string | undefined } {
  const userId = req.user?.id;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return { actor: { userId, requestId: req.requestId ?? "missing-request-id", path: req.originalUrl.split("?")[0]! },
    idempotencyKey: typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : undefined };
}
const handle = (work: RequestHandler): RequestHandler => async (req,res,next) => { try { context(req); await work(req,res,next); } catch(error) { next(error); } };
export const listProformas = handle(async (req,res) => { res.json(await svcListProformas(proformaListQuerySchema.parse(req.query))); });
export const getProforma = handle(async (req,res) => { res.json(await svcGetProforma(proformaIdParamsSchema.parse(req.params).id)); });
export const previewProforma = handle(async (req,res) => { res.json(await svcPreviewProforma(proformaDraftBodySchema.parse(req.body))); });
export const previewExistingProforma = handle(async (req,res) => { res.json(await svcPreviewExistingProforma(proformaIdParamsSchema.parse(req.params).id)); });
export const createProforma = handle(async (req,res) => {
  const result = await svcCreateProforma({ ...context(req), input: proformaCreateBodySchema.parse(req.body) });
  res.status(result.idempotent_replay ? 200 : 201).json(result);
});
export const issueProforma = handle(async (req,res) => {
  res.json(await svcIssueProforma({ ...context(req), id: proformaIdParamsSchema.parse(req.params).id, input: proformaIssueBodySchema.parse(req.body) }));
});
export const previewProformaChanges = handle(async (req,res) => {
  res.json(await svcPreviewProformaChanges(proformaIdParamsSchema.parse(req.params).id, proformaDraftBodySchema.parse(req.body)));
});
export const refreshProforma = handle(async (req,res) => {
  res.json(await svcRefreshProforma({ ...context(req), id: proformaIdParamsSchema.parse(req.params).id, input: proformaRefreshBodySchema.parse(req.body) }));
});
export const cancelProforma = handle(async (req,res) => {
  res.json(await svcCancelProforma({ ...context(req), id: proformaIdParamsSchema.parse(req.params).id, input: proformaCancelBodySchema.parse(req.body) }));
});
export const assignProformaReceipts = handle(async (req,res) => {
  res.json(await svcAssignProformaReceipts({ ...context(req), id: proformaIdParamsSchema.parse(req.params).id, input: proformaReceiptAssignmentBodySchema.parse(req.body) }));
});
export const releaseProformaReceipt = handle(async (req,res) => {
  const params = proformaReceiptReleaseParamsSchema.parse(req.params);
  res.json(await svcReleaseProformaReceipt({ ...context(req), id: params.id, assignmentId: params.assignmentId, input: proformaReceiptReleaseBodySchema.parse(req.body) }));
});
export const decideDeliveryPrepaymentTerms = handle(async (req,res) => {
  res.json(await svcDecideDeliveryPrepaymentTerms({ ...context(req), allocationId: proformaAllocationParamsSchema.parse(req.params).allocationId,
    input: deliveryPrepaymentTermsBodySchema.parse(req.body) }));
});
