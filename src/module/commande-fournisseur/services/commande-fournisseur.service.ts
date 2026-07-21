import type {
  AccuseBodyDTO,
  AddLigneBodyDTO,
  CreateCommandeBodyDTO,
  PropositionsConfirmBodyDTO,
  PropositionsPreviewBodyDTO,
  ReorderLignesBodyDTO,
  SimulateTotauxBodyDTO,
  TransitionBodyDTO,
  UpdateCommandeBodyDTO,
  UpdateLigneBodyDTO,
} from "../validators/commande-fournisseur.validators";
import { computeCommandeTotaux } from "../domain/commande-fournisseur-totaux";
import {
  repoAccuseReception,
  repoAddLigne,
  repoConfirmPropositions,
  repoCreateCommandeFournisseur,
  repoDeleteLigne,
  repoDuplicateAsDraft,
  repoGenerateDocumentVersion,
  repoGetCommandeFournisseur,
  repoGetDocument,
  repoGetKpis,
  repoListCommandesFournisseurs,
  repoPreviewPropositions,
  repoReorderLignes,
  repoResyncReceptions,
  repoTransitionCommandeFournisseur,
  repoUpdateCommandeFournisseur,
  repoUpdateLigne,
  type AuditContext,
  type ListCommandesParams,
} from "../repository/commande-fournisseur.repository";

export const listCommandesFournisseursSVC = (params: ListCommandesParams, includePrices: boolean) =>
  repoListCommandesFournisseurs(params, { includePrices });

export const getCommandeFournisseurKpisSVC = () => repoGetKpis();

export const getCommandeFournisseurSVC = (id: string, includePrices: boolean) =>
  repoGetCommandeFournisseur(id, { includePrices });

export const createCommandeFournisseurSVC = (body: CreateCommandeBodyDTO, audit: AuditContext) =>
  repoCreateCommandeFournisseur(body, audit);

export const updateCommandeFournisseurSVC = (id: string, body: UpdateCommandeBodyDTO, audit: AuditContext) =>
  repoUpdateCommandeFournisseur(id, body, audit);

export const addLigneSVC = (id: string, body: AddLigneBodyDTO, audit: AuditContext) => repoAddLigne(id, body, audit);

export const updateLigneSVC = (id: string, ligneId: string, body: UpdateLigneBodyDTO, audit: AuditContext) =>
  repoUpdateLigne(id, ligneId, body, audit);

export const deleteLigneSVC = (
  id: string,
  ligneId: string,
  expectedUpdatedAt: string | undefined,
  audit: AuditContext
) => repoDeleteLigne(id, ligneId, expectedUpdatedAt, audit);

export const reorderLignesSVC = (id: string, body: ReorderLignesBodyDTO, audit: AuditContext) =>
  repoReorderLignes(id, body, audit);

export const transitionCommandeFournisseurSVC = (id: string, body: TransitionBodyDTO, audit: AuditContext) =>
  repoTransitionCommandeFournisseur(id, body, audit);

export const accuseReceptionSVC = (id: string, body: AccuseBodyDTO, audit: AuditContext) =>
  repoAccuseReception(id, body, audit);

export const generateDocumentSVC = (
  id: string,
  motifRevision: string | undefined,
  expectedUpdatedAt: string | undefined,
  audit: AuditContext
) => repoGenerateDocumentVersion(id, motifRevision, expectedUpdatedAt, audit);

export const getDocumentSVC = (id: string, documentId: string) => repoGetDocument(id, documentId);

export const simulateTotauxSVC = (body: SimulateTotauxBodyDTO) =>
  computeCommandeTotaux(
    body.lignes.map((l) => ({ ...l, statut_ligne: "ACTIVE" as const })),
    { frais_port_ht: body.frais_port_ht, tva_frais_pct: body.tva_frais_pct }
  );

export const previewPropositionsSVC = (body: PropositionsPreviewBodyDTO) => repoPreviewPropositions(body);

export const confirmPropositionsSVC = (body: PropositionsConfirmBodyDTO, audit: AuditContext) =>
  repoConfirmPropositions(body, audit);

export const resyncReceptionsSVC = (id: string, audit: AuditContext, allowOverReceipt: boolean) =>
  repoResyncReceptions(id, audit, allowOverReceipt);

export const duplicateAsDraftSVC = (id: string, note: string | undefined, audit: AuditContext) =>
  repoDuplicateAsDraft(id, note, audit);
