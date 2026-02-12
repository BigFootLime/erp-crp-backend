// src/module/pieces-techniques/services/pieces-techniques.service.ts
import { HttpError } from "../../../utils/httpError";
import type { PieceTechniqueStatut } from "../types/pieces-techniques.types";
import type {
  AddAchatBodyDTO,
  AddBomLineBodyDTO,
  AddOperationBodyDTO,
  CreatePieceTechniqueBodyDTO,
  ListPiecesTechniquesQueryDTO,
  PieceTechniqueStatusBodyDTO,
  UpdateAchatBodyDTO,
  UpdateBomLineBodyDTO,
  UpdateOperationBodyDTO,
  UpdatePieceTechniqueBodyDTO,
} from "../validators/pieces-techniques.validators";
import {
  repoAddAchat,
  repoAddBomLine,
  repoAddOperation,
  repoDeleteAchat,
  repoDeleteBomLine,
  repoDeleteOperation,
  repoDeletePieceTechnique,
  repoDuplicatePieceTechnique,
  repoListAffairePieceTechniques,
  repoGetPieceTechniqueDocumentForDownload,
  repoGetPieceTechnique,
  repoListPieceTechniqueAffaires,
  repoListPieceTechniqueDocuments,
  repoListPieceTechniques,
  repoReorderAchats,
  repoReorderBom,
  repoReorderOperations,
  repoUnlinkPieceTechniqueFromAffaire,
  repoUpsertPieceTechniqueAffaireLink,
  repoAttachPieceTechniqueDocuments,
  repoRemovePieceTechniqueDocument,
  repoUpdateAchat,
  repoUpdateBomLine,
  repoUpdateOperation,
  repoUpdatePieceTechnique,
  repoUpdatePieceTechniqueStatus,
  repoCreatePieceTechnique,
  type AuditContext,
} from "../repository/pieces-techniques.repository";

type UploadedDocument = Express.Multer.File;

function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function computeOperation(op: AddOperationBodyDTO | UpdateOperationBodyDTO) {
  const tp = typeof op.tp === "number" ? op.tp : 0;
  const tfUnit = typeof op.tf_unit === "number" ? op.tf_unit : 0;
  const qte = typeof op.qte === "number" ? op.qte : 1;
  const coef = typeof op.coef === "number" ? op.coef : 1;
  const tauxHoraire = typeof op.taux_horaire === "number" ? op.taux_horaire : 0;

  const tempsTotal = roundTo((tp + tfUnit * qte) * coef, 3);
  const coutMo = roundTo(tempsTotal * tauxHoraire, 2);
  return { temps_total: tempsTotal, cout_mo: coutMo };
}

function computeAchat(a: AddAchatBodyDTO | UpdateAchatBodyDTO) {
  const quantite = typeof a.quantite === "number" ? a.quantite : 1;
  const prix = typeof a.prix === "number" ? a.prix : 0;
  const tva = typeof a.tva_achat === "number" ? a.tva_achat : 20;

  const totalHt = roundTo(quantite * prix, 2);
  const totalTtc = roundTo(totalHt * (1 + tva / 100), 2);
  return { total_achat_ht: totalHt, total_achat_ttc: totalTtc };
}

function isValidTransition(from: PieceTechniqueStatut, to: PieceTechniqueStatut): boolean {
  if (from === to) return true;
  const rules: Record<PieceTechniqueStatut, readonly PieceTechniqueStatut[]> = {
    DRAFT: ["ACTIVE", "OBSOLETE"],
    ACTIVE: ["IN_FABRICATION", "OBSOLETE"],
    IN_FABRICATION: ["ACTIVE", "OBSOLETE"],
    OBSOLETE: [],
  };
  return rules[from].includes(to);
}

export const listPieceTechniquesSVC = (filters: ListPiecesTechniquesQueryDTO) => repoListPieceTechniques(filters);

export const getPieceTechniqueSVC = (id: string, includes: Set<string>) => repoGetPieceTechnique(id, includes);

export async function createPieceTechniqueSVC(body: CreatePieceTechniqueBodyDTO, audit: AuditContext) {
  const statut = body.statut ?? "DRAFT";
  const enFabrication = statut === "IN_FABRICATION";

  const operations = (body.operations ?? []).map((op) => ({
    ...op,
    ...computeOperation(op),
  }));
  const achats = (body.achats ?? []).map((a) => ({
    ...a,
    ...computeAchat(a),
  }));

  try {
    return await repoCreatePieceTechnique(
      {
        ...body,
        statut,
        en_fabrication: enFabrication,
        operations,
        achats,
      },
      audit
    );
  } catch (err: unknown) {
    // pg unique violation
    const code = (err as { code?: unknown } | null)?.code;
    const detail = (err as { detail?: unknown } | null)?.detail;
    if (code === "23505") {
      const msg = typeof detail === "string" && detail.includes("code_piece") ? "Code de pièce déjà utilisé" : "Conflit de contrainte";
      throw new HttpError(409, "CONFLICT", msg);
    }
    throw err;
  }
}

export async function updatePieceTechniqueSVC(id: string, body: UpdatePieceTechniqueBodyDTO, audit: AuditContext) {
  if (body.statut !== undefined) {
    throw new HttpError(400, "STATUS_FORBIDDEN", "Use /status endpoint to change statut");
  }
  if (body.bom !== undefined || body.operations !== undefined || body.achats !== undefined) {
    throw new HttpError(400, "SUBRESOURCE_FORBIDDEN", "Use nomenclature/operations/achats endpoints to edit lines");
  }
  return repoUpdatePieceTechnique(id, body, audit);
}

export const deletePieceTechniqueSVC = (id: string, audit: AuditContext) => repoDeletePieceTechnique(id, audit);

export async function duplicatePieceTechniqueSVC(id: string, userId: number | null) {
  return repoDuplicatePieceTechnique(id, userId);
}

export async function updatePieceTechniqueStatusSVC(id: string, body: PieceTechniqueStatusBodyDTO, audit: AuditContext) {
  const current = await repoGetPieceTechnique(id, new Set());
  if (!current) return null;

  const from = current.statut;
  const to = body.next_statut;
  if (!isValidTransition(from, to)) {
    throw new HttpError(409, "INVALID_TRANSITION", `Invalid transition from ${from} to ${to}`);
  }
  return repoUpdatePieceTechniqueStatus(id, from, to, body.commentaire ?? null, body.expected_updated_at, audit);
}

export async function listPieceTechniqueDocumentsSVC(pieceTechniqueId: string) {
  return repoListPieceTechniqueDocuments(pieceTechniqueId);
}

export async function attachPieceTechniqueDocumentsSVC(pieceTechniqueId: string, documents: UploadedDocument[], audit: AuditContext) {
  return repoAttachPieceTechniqueDocuments(pieceTechniqueId, documents, audit);
}

export async function removePieceTechniqueDocumentSVC(pieceTechniqueId: string, docId: string, audit: AuditContext) {
  return repoRemovePieceTechniqueDocument(pieceTechniqueId, docId, audit);
}

export async function downloadPieceTechniqueDocumentSVC(pieceTechniqueId: string, docId: string, audit: AuditContext) {
  return repoGetPieceTechniqueDocumentForDownload(pieceTechniqueId, docId, audit);
}

export async function listPieceTechniqueAffairesSVC(pieceTechniqueId: string) {
  return repoListPieceTechniqueAffaires(pieceTechniqueId);
}

export async function linkPieceTechniqueAffaireSVC(
  pieceTechniqueId: string,
  affaireId: number,
  role: "MAIN" | "LINKED",
  audit: AuditContext
) {
  return repoUpsertPieceTechniqueAffaireLink(pieceTechniqueId, affaireId, role, audit);
}

export async function unlinkPieceTechniqueAffaireSVC(pieceTechniqueId: string, affaireId: number, audit: AuditContext) {
  return repoUnlinkPieceTechniqueFromAffaire(pieceTechniqueId, affaireId, audit);
}

export async function listAffairePieceTechniquesSVC(affaireId: number) {
  return repoListAffairePieceTechniques(affaireId);
}

export async function addBomLineSVC(pieceTechniqueId: string, body: AddBomLineBodyDTO) {
  return repoAddBomLine(pieceTechniqueId, body);
}

export async function updateBomLineSVC(pieceTechniqueId: string, lineId: string, body: UpdateBomLineBodyDTO) {
  return repoUpdateBomLine(pieceTechniqueId, lineId, body);
}

export async function deleteBomLineSVC(pieceTechniqueId: string, lineId: string) {
  return repoDeleteBomLine(pieceTechniqueId, lineId);
}

export async function reorderBomSVC(pieceTechniqueId: string, order: string[]) {
  return repoReorderBom(pieceTechniqueId, order);
}

export async function addOperationSVC(pieceTechniqueId: string, body: AddOperationBodyDTO) {
  return repoAddOperation(pieceTechniqueId, {
    ...body,
    ...computeOperation(body),
  });
}

export async function updateOperationSVC(pieceTechniqueId: string, opId: string, body: UpdateOperationBodyDTO) {
  const computed = computeOperation(body);
  return repoUpdateOperation(pieceTechniqueId, opId, { ...body, ...computed });
}

export async function deleteOperationSVC(pieceTechniqueId: string, opId: string) {
  return repoDeleteOperation(pieceTechniqueId, opId);
}

export async function reorderOperationsSVC(pieceTechniqueId: string, order: string[]) {
  return repoReorderOperations(pieceTechniqueId, order);
}

export async function addAchatSVC(pieceTechniqueId: string, body: AddAchatBodyDTO) {
  return repoAddAchat(pieceTechniqueId, {
    ...body,
    ...computeAchat(body),
  });
}

export async function updateAchatSVC(pieceTechniqueId: string, achatId: string, body: UpdateAchatBodyDTO) {
  const computed = computeAchat(body);
  return repoUpdateAchat(pieceTechniqueId, achatId, { ...body, ...computed });
}

export async function deleteAchatSVC(pieceTechniqueId: string, achatId: string) {
  return repoDeleteAchat(pieceTechniqueId, achatId);
}

export async function reorderAchatsSVC(pieceTechniqueId: string, order: string[]) {
  return repoReorderAchats(pieceTechniqueId, order);
}
