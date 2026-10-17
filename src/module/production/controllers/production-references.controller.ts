import { asyncHandler } from "../../../utils/asyncHandler";
import {
  productionReferenceListQuerySchema,
  productionReferencePieceParamSchema,
  productionReferenceReceiptParamSchema,
} from "../validators/production-references.validators";
import {
  svcGetReceiptStockReference,
  svcListProductionReferenceClients,
  svcListProductionReferencePieces,
  svcListProductionReferencePieceVersions,
} from "../services/production-references.service";

export const listProductionReferenceClients = asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await svcListProductionReferenceClients(productionReferenceListQuerySchema.parse(req.query)));
});

export const listProductionReferencePieces = asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await svcListProductionReferencePieces(productionReferenceListQuerySchema.parse(req.query)));
});

export const listProductionReferencePieceVersions = asyncHandler(async (req, res) => {
  const { pieceId } = productionReferencePieceParamSchema.parse({ params: req.params }).params;
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await svcListProductionReferencePieceVersions(pieceId));
});

export const getReceiptStockReference = asyncHandler(async (req, res) => {
  const { id, movementId } = productionReferenceReceiptParamSchema.parse({ params: req.params }).params;
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await svcGetReceiptStockReference({ ofId: id, movementId }));
});