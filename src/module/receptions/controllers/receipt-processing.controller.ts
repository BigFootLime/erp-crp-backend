import type { Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { buildAuditContext } from "../../production/controllers/production.controller";
import { consumableAccountRights } from "../../stock/domain/consumable-access";
import * as repo from "../repository/receipt-processing.repository";
import * as schema from "../validators/receipt-processing.validators";
import { repoCreateStockReceipt } from "../repository/receptions.repository";
import { stockToolReceipt } from "../repository/receipt-tool-stock.repository";
import { bindReceiptSubcontract } from "../repository/receipt-subcontract.repository";

export async function requireReceiptProcessingAccess(
  req: Request,
  write = false,
) {
  const rights = await consumableAccountRights(req);
  if (!(write ? rights.receive : rights.documents))
    throw new HttpError(
      403,
      "RECEIPT_PROCESSING_FORBIDDEN",
      "Les droits de réception sont nécessaires pour cette action.",
    );
  return rights;
}
const ids = (req: Request) =>
  [
    z.string().uuid().parse(req.params.id),
    z.string().uuid().parse(req.params.lineId),
  ] as const;
export const listProcessing = asyncHandler(async (req, res) => {
  const permissions = await requireReceiptProcessingAccess(req);
  const result = await repo.listProcessingLines(
    schema.processingQuerySchema.parse(req.query),
  );
  res.json({
    ...result,
    items: result.items.map((line) => ({
      ...line,
      allowedActions: repo.receiptAllowedActions(line, permissions.receive),
    })),
    permissions,
  });
});
export const getProcessing = asyncHandler(async (req, res) => {
  const permissions = await requireReceiptProcessingAccess(req);
  const line = await repo.getProcessingLine(...ids(req));
  res.json({
    ...line,
    permissions,
    allowedActions: repo.receiptAllowedActions(line, permissions.receive),
  });
});
export const packProcessing = asyncHandler(async (req, res) => {
  await requireReceiptProcessingAccess(req, true);
  res.json(
    await repo.packReceipt(
      ...ids(req),
      schema.packReceiptSchema.parse(req.body),
      buildAuditContext(req),
    ),
  );
});
export const stockProcessing = asyncHandler(async (req, res) => {
  await requireReceiptProcessingAccess(req, true);
  const body = schema.stockProcessingSchema.parse(req.body);
  const [receptionId, lineId] = ids(req);
  await repoCreateStockReceipt(
    receptionId,
    lineId,
    {
      qty: body.quantity,
      dst_magasin_id: body.magasinId,
      dst_emplacement_id: body.emplacementId,
      expected_processing_version: body.expectedVersion,
    },
    buildAuditContext(req),
    body.idempotencyKey,
  );
  res.json(await repo.getProcessingLine(receptionId, lineId));
});
export const toolStockProcessing = asyncHandler(async (req, res) => {
  await requireReceiptProcessingAccess(req, true);
  res.json(
    await stockToolReceipt(
      ...ids(req),
      schema.toolStockProcessingSchema.parse(req.body),
      buildAuditContext(req),
    ),
  );
});
export const subcontractProcessing = asyncHandler(async (req, res) => {
  await requireReceiptProcessingAccess(req, true);
  await bindReceiptSubcontract(
    ...ids(req),
    schema.subcontractProcessingSchema.parse(req.body),
    buildAuditContext(req),
  );
  res.json(await repo.getProcessingLine(...ids(req)));
});
export const mapProcessing = asyncHandler(async (req, res) => {
  await requireReceiptProcessingAccess(req, true);
  res.json(
    await repo.configureStockArticle(
      ...ids(req),
      schema.mapReceiptArticleSchema.parse(req.body),
      buildAuditContext(req),
    ),
  );
});
export const reconcileProcessing = asyncHandler(async (req, res) => {
  await requireReceiptProcessingAccess(req, true);
  res.json(
    await repo.reconcileProcessing(
      ...ids(req),
      schema.reconcileReceiptSchema.parse(req.body),
      buildAuditContext(req),
    ),
  );
});
export const voidProcessing = asyncHandler(async (req, res) => {
  await requireReceiptProcessingAccess(req, true);
  res.json(
    await repo.voidPackaging(
      ...ids(req),
      schema.voidPackagingSchema.parse(req.body),
      buildAuditContext(req),
    ),
  );
});
