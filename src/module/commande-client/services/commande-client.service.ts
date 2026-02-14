import type { CreateCommandeInput, UploadedDocument } from "../types/commande-client.types";
import type { ListCommandesQueryDTO } from "../validators/commande-client.validators";
import {
  repoCreateCommande,
  repoDeleteCommande,
  repoDuplicateCommande,
  repoGenerateAffairesFromOrder,
  repoGetCommande,
  repoGetCommandeDocumentFileMeta,
  repoListCommandes,
  repoUpdateCommande,
  repoUpdateCommandeStatus,
} from "../repository/commande-client.repository";

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

export const duplicateCommandeSVC = (id: string) => repoDuplicateCommande(id);
