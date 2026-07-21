import type {
  AttachDocumentsBodyDTO,
  CreateAdresseBodyDTO,
  CreateCatalogueBodyDTO,
  CreateContactBodyDTO,
  CreateFournisseurBodyDTO,
  CreateHomologationBodyDTO,
  DoublonQueryDTO,
  ListCatalogueQueryDTO,
  ListFournisseursQueryDTO,
  PutFournisseurDomainesDTO,
  UpdateAdresseBodyDTO,
  UpdateCatalogueBodyDTO,
  UpdateContactBodyDTO,
  UpdateFournisseurBodyDTO,
  UpdateHomologationBodyDTO,
} from "../validators/fournisseurs.validators"
import type { AuditContext } from "../repository/fournisseurs.repository"
import * as repo from "../repository/fournisseurs.repository"

type UploadedDocument = Express.Multer.File

export const listFournisseursSVC = (filters: ListFournisseursQueryDTO) => repo.repoListFournisseurs(filters)
export const getFournisseurSVC = (id: string) => repo.repoGetFournisseur(id)
export const listFournisseurDomainesSVC = () => repo.repoListFournisseurDomaines()
export const replaceFournisseurDomainesSVC = (id: string, body: PutFournisseurDomainesDTO, audit: AuditContext) =>
  repo.repoReplaceFournisseurDomaines(id, body.domaines, audit)
export const listFournisseurEventsSVC = (id: string) => repo.repoListFournisseurEvents(id)
export const findDoublonsSVC = (filters: DoublonQueryDTO) => repo.repoFindDoublons(filters)

const SIRET_TVA_CONFLICT = "Un fournisseur avec ce SIRET ou cette TVA existe déjà"

export async function createFournisseurSVC(body: CreateFournisseurBodyDTO, audit: AuditContext) {
  try {
    return await repo.repoCreateFournisseur(body, audit)
  } catch (err) {
    repo.assertNoUniqueViolation(err, SIRET_TVA_CONFLICT)
    throw err
  }
}

export async function updateFournisseurSVC(id: string, patch: UpdateFournisseurBodyDTO, audit: AuditContext) {
  try {
    return await repo.repoUpdateFournisseur(id, patch, audit)
  } catch (err) {
    repo.assertNoUniqueViolation(err, SIRET_TVA_CONFLICT)
    throw err
  }
}

export const deactivateFournisseurSVC = (id: string, audit: AuditContext) => repo.repoDeactivateFournisseur(id, audit)
export const archiveFournisseurSVC = (id: string, motif: string | null, audit: AuditContext) =>
  repo.repoArchiveFournisseur(id, motif, audit)

export const listFournisseurContactsSVC = (id: string) => repo.repoListFournisseurContacts(id)
export const createFournisseurContactSVC = (id: string, body: CreateContactBodyDTO, audit: AuditContext) =>
  repo.repoCreateFournisseurContact(id, body, audit)
export const updateFournisseurContactSVC = (id: string, contactId: string, patch: UpdateContactBodyDTO, audit: AuditContext) =>
  repo.repoUpdateFournisseurContact(id, contactId, patch, audit)
export const deleteFournisseurContactSVC = (id: string, contactId: string, audit: AuditContext) =>
  repo.repoSoftDeleteFournisseurContact(id, contactId, audit)

export const listFournisseurAdressesSVC = (id: string) => repo.repoListFournisseurAdresses(id)
export const createFournisseurAdresseSVC = (id: string, body: CreateAdresseBodyDTO, audit: AuditContext) =>
  repo.repoCreateFournisseurAdresse(id, body, audit)
export const updateFournisseurAdresseSVC = (id: string, adresseId: string, patch: UpdateAdresseBodyDTO, audit: AuditContext) =>
  repo.repoUpdateFournisseurAdresse(id, adresseId, patch, audit)
export const deleteFournisseurAdresseSVC = (id: string, adresseId: string, audit: AuditContext) =>
  repo.repoSoftDeleteFournisseurAdresse(id, adresseId, audit)

export const listFournisseurHomologationsSVC = (id: string) => repo.repoListFournisseurHomologations(id)
export const createFournisseurHomologationSVC = (id: string, body: CreateHomologationBodyDTO, audit: AuditContext) =>
  repo.repoCreateFournisseurHomologation(id, body, audit)
export const updateFournisseurHomologationSVC = (id: string, homologationId: string, patch: UpdateHomologationBodyDTO, audit: AuditContext) =>
  repo.repoUpdateFournisseurHomologation(id, homologationId, patch, audit)

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
