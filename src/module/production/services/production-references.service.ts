import * as repository from "../repository/production-references.repository";
import type { ProductionReferenceListQuery } from "../validators/production-references.validators";

export const svcListProductionReferenceClients = (query: ProductionReferenceListQuery) =>
  repository.repoListProductionReferenceClients(query);
export const svcListProductionReferencePieces = (query: ProductionReferenceListQuery) =>
  repository.repoListProductionReferencePieces(query);
export const svcListProductionReferencePieceVersions = (pieceId: string) =>
  repository.repoListProductionReferencePieceVersions(pieceId);
export const svcGetReceiptStockReference = (params: { ofId: number; movementId: string }) =>
  repository.repoGetReceiptStockReference(params);