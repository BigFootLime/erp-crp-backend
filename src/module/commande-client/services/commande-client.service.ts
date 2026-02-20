import type { CreateCommandeInput, UploadedDocument } from "../types/commande-client.types";
import type { ListCommandesQueryDTO } from "../validators/commande-client.validators";
import {
  repoCreateCommande,
  repoDeleteCommande,
  repoDuplicateCommande,
  repoConfirmGenerateAffaires,
  repoGenerateAffairesFromCommande,
  repoGenerateAffairesFromOrder,
  repoGetCommande,
  repoGetCommandeDocumentFileMeta,
  repoListCommandes,
  repoPreviewAffairesFromCommande,
  repoUpdateCommande,
  repoUpdateCommandeStatus,
} from "../repository/commande-client.repository";

import {
  repoAddCadreReleaseLine,
  repoCancelCadreRelease,
  repoCreateCadreRelease,
  repoGetCadreRelease,
  repoListCadreReleases,
  repoUpdateCadreRelease,
  repoUpdateCadreReleaseLine,
  repoUpdateCadreReleaseStatus,
  repoDeleteCadreReleaseLine,
} from "../repository/commande-cadre-release.repository";

import type { CadreReleaseStatus } from "../types/commande-client.types";
import type {
  CreateCadreReleaseBodyDTO,
  CreateCadreReleaseLineBodyDTO,
  ConfirmGenerateAffairesBodyDTO,
  GenerateAffairesBodyDTO,
  UpdateCadreReleaseBodyDTO,
  UpdateCadreReleaseLineBodyDTO,
} from "../validators/commande-client.validators";

export const createCommandeSVC = (input: CreateCommandeInput, documents: UploadedDocument[]) =>
  repoCreateCommande(input, documents);

export const updateCommandeSVC = (id: string, input: CreateCommandeInput, documents: UploadedDocument[]) =>
  repoUpdateCommande(id, input, documents);

export const listCommandesSVC = (filters: ListCommandesQueryDTO) => repoListCommandes(filters);

export const getCommandeSVC = (id: string, includes: Set<string>) => repoGetCommande(id, includes);

export const getCommandeDocumentFileMetaSVC = (commandeId: string, docId: string) =>
  repoGetCommandeDocumentFileMeta(commandeId, docId);

export const deleteCommandeSVC = (id: string) => repoDeleteCommande(id);

export const updateCommandeStatusSVC = (
  id: string,
  nouveau_statut: string,
  commentaire: string | null,
  userId: number | null
) => repoUpdateCommandeStatus(id, nouveau_statut, commentaire, userId);

export const generateAffairesFromOrderSVC = (id: string) => repoGenerateAffairesFromOrder(id);

export const previewAffairesFromCommandeSVC = (id: string) => repoPreviewAffairesFromCommande(id);

export const generateAffairesFromCommandeSVC = (id: string, body: GenerateAffairesBodyDTO) =>
  repoGenerateAffairesFromCommande(id, body);

export const confirmGenerateAffairesSVC = (id: string, body: ConfirmGenerateAffairesBodyDTO) =>
  repoConfirmGenerateAffaires(id, body);

export const duplicateCommandeSVC = (id: string) => repoDuplicateCommande(id);

export const listCadreReleasesSVC = (commandeId: string, opts?: { includeLines?: boolean }) =>
  repoListCadreReleases(commandeId, opts);

export const getCadreReleaseSVC = (commandeId: string, releaseId: string) => repoGetCadreRelease(commandeId, releaseId);

export const createCadreReleaseSVC = (commandeId: string, dto: CreateCadreReleaseBodyDTO, userId: number | null) =>
  repoCreateCadreRelease(commandeId, dto, userId);

export const updateCadreReleaseSVC = (commandeId: string, releaseId: string, dto: UpdateCadreReleaseBodyDTO, userId: number | null) =>
  repoUpdateCadreRelease(commandeId, releaseId, dto, userId);

export const updateCadreReleaseStatusSVC = (
  commandeId: string,
  releaseId: string,
  statut: CadreReleaseStatus,
  userId: number | null,
  opts?: { notes?: string | null }
) => repoUpdateCadreReleaseStatus(commandeId, releaseId, statut, userId, opts);

export const cancelCadreReleaseSVC = (commandeId: string, releaseId: string, userId: number | null) =>
  repoCancelCadreRelease(commandeId, releaseId, userId);

export const addCadreReleaseLineSVC = (commandeId: string, releaseId: string, dto: CreateCadreReleaseLineBodyDTO, userId: number | null) =>
  repoAddCadreReleaseLine(commandeId, releaseId, dto, userId);

export const updateCadreReleaseLineSVC = (
  commandeId: string,
  releaseId: string,
  lineId: string,
  dto: UpdateCadreReleaseLineBodyDTO,
  userId: number | null
) => repoUpdateCadreReleaseLine(commandeId, releaseId, lineId, dto, userId);

export const deleteCadreReleaseLineSVC = (commandeId: string, releaseId: string, lineId: string, userId: number | null) =>
  repoDeleteCadreReleaseLine(commandeId, releaseId, lineId, userId);
