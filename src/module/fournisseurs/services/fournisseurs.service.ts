import type {
  AttachDocumentsBodyDTO,
  CreateCatalogueBodyDTO,
  CreateContactBodyDTO,
  CreateFournisseurBodyDTO,
  ListCatalogueQueryDTO,
  ListFournisseursQueryDTO,
  UpdateCatalogueBodyDTO,
  UpdateContactBodyDTO,
  UpdateFournisseurBodyDTO,
} from "../validators/fournisseurs.validators"
import type { AuditContext } from "../repository/fournisseurs.repository"
import * as repo from "../repository/fournisseurs.repository"

type UploadedDocument = Express.Multer.File

export const listFournisseursSVC = (filters: ListFournisseursQueryDTO) => repo.repoListFournisseurs(filters)

export const getFournisseurSVC = (id: string) => repo.repoGetFournisseur(id)

export async function createFournisseurSVC(body: CreateFournisseurBodyDTO, audit: AuditContext) {
  try {
    return await repo.repoCreateFournisseur(body, audit)
  } catch (err) {
    repo.assertNoUniqueViolation(err, "Code fournisseur déjà utilisé")
    throw err
  }
}

export async function updateFournisseurSVC(id: string, patch: UpdateFournisseurBodyDTO, audit: AuditContext) {
  try {
    return await repo.repoUpdateFournisseur(id, patch, audit)
  } catch (err) {
    repo.assertNoUniqueViolation(err, "Code fournisseur déjà utilisé")
    throw err
  }
}

export const deactivateFournisseurSVC = (id: string, audit: AuditContext) => repo.repoDeactivateFournisseur(id, audit)

export const listFournisseurContactsSVC = (id: string) => repo.repoListFournisseurContacts(id)

export const createFournisseurContactSVC = (id: string, body: CreateContactBodyDTO, audit: AuditContext) =>
  repo.repoCreateFournisseurContact(id, body, audit)

export const updateFournisseurContactSVC = (id: string, contactId: string, patch: UpdateContactBodyDTO, audit: AuditContext) =>
  repo.repoUpdateFournisseurContact(id, contactId, patch, audit)

export const deleteFournisseurContactSVC = (id: string, contactId: string, audit: AuditContext) =>
  repo.repoSoftDeleteFournisseurContact(id, contactId, audit)

export const listFournisseurCatalogueSVC = (id: string, filters: ListCatalogueQueryDTO) =>
  repo.repoListFournisseurCatalogue(id, filters)

export const createFournisseurCatalogueItemSVC = (id: string, body: CreateCatalogueBodyDTO, audit: AuditContext) =>
  repo.repoCreateFournisseurCatalogueItem(id, body, audit)

export const updateFournisseurCatalogueItemSVC = (id: string, catalogueId: string, patch: UpdateCatalogueBodyDTO, audit: AuditContext) =>
  repo.repoUpdateFournisseurCatalogueItem(id, catalogueId, patch, audit)

export const deleteFournisseurCatalogueItemSVC = (id: string, catalogueId: string, audit: AuditContext) =>
  repo.repoSoftDeleteFournisseurCatalogueItem(id, catalogueId, audit)

export const listFournisseurDocumentsSVC = (id: string) => repo.repoListFournisseurDocuments(id)

export const attachFournisseurDocumentsSVC = (id: string, body: AttachDocumentsBodyDTO, docs: UploadedDocument[], audit: AuditContext) =>
  repo.repoAttachFournisseurDocuments(id, body, docs, audit)

export const removeFournisseurDocumentSVC = (id: string, docId: string, audit: AuditContext) =>
  repo.repoRemoveFournisseurDocument(id, docId, audit)

export const downloadFournisseurDocumentSVC = (id: string, docId: string, audit: AuditContext) =>
  repo.repoGetFournisseurDocumentForDownload(id, docId, audit)
