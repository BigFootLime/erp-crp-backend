import type {
  CreateActionBodyDTO,
  CreateControlBodyDTO,
  CreateNonConformityBodyDTO,
  KpisQueryDTO,
  ListActionsQueryDTO,
  ListControlsQueryDTO,
  ListNonConformitiesQueryDTO,
  ListUsersQueryDTO,
  PatchActionBodyDTO,
  PatchControlBodyDTO,
  PatchNonConformityBodyDTO,
  QualityDocumentTypeDTO,
  QualityEntityTypeDTO,
  ValidateControlBodyDTO,
} from "../validators/qualite.validators";
import type {
  NonConformityDetail,
  NonConformityListItem,
  Paginated,
  QualityActionDetail,
  QualityActionListItem,
  QualityControlDetail,
  QualityControlListItem,
  QualityDocument,
  QualityKpis,
  QualityUserLite,
} from "../types/qualite.types";
import type { AuditContext } from "../repository/qualite.repository";
import {
  qualityDocumentBaseDir,
  repoAttachDocuments,
  repoCreateAction,
  repoCreateControl,
  repoCreateNonConformity,
  repoGetAction,
  repoGetControl,
  repoGetDocumentForDownload,
  repoGetNonConformity,
  repoKpis,
  repoListActions,
  repoListControls,
  repoListDocuments,
  repoListNonConformities,
  repoListUsers,
  repoPatchAction,
  repoPatchControl,
  repoPatchNonConformity,
  repoRemoveDocument,
  repoValidateControl,
} from "../repository/qualite.repository";

type UploadedDocument = Express.Multer.File;

export const svcKpis = (filters: KpisQueryDTO): Promise<QualityKpis> => repoKpis(filters);

export const svcListUsers = (filters: ListUsersQueryDTO): Promise<QualityUserLite[]> => repoListUsers(filters);

export const svcListControls = (filters: ListControlsQueryDTO): Promise<Paginated<QualityControlListItem>> => repoListControls(filters);

export const svcGetControl = (id: string): Promise<QualityControlDetail | null> => repoGetControl(id);

export const svcCreateControl = (params: { body: CreateControlBodyDTO; audit: AuditContext }): Promise<QualityControlDetail> =>
  repoCreateControl(params);

export const svcPatchControl = (params: { id: string; body: PatchControlBodyDTO; audit: AuditContext }): Promise<QualityControlDetail | null> =>
  repoPatchControl(params);

export const svcValidateControl = (params: { id: string; body: ValidateControlBodyDTO; audit: AuditContext }): Promise<QualityControlDetail | null> =>
  repoValidateControl(params);

export const svcListNonConformities = (
  filters: ListNonConformitiesQueryDTO
): Promise<Paginated<NonConformityListItem>> => repoListNonConformities(filters);

export const svcGetNonConformity = (id: string): Promise<NonConformityDetail | null> => repoGetNonConformity(id);

export const svcCreateNonConformity = (
  params: { body: CreateNonConformityBodyDTO; audit: AuditContext }
): Promise<NonConformityDetail> => repoCreateNonConformity(params);

export const svcPatchNonConformity = (
  params: { id: string; body: PatchNonConformityBodyDTO; audit: AuditContext }
): Promise<NonConformityDetail | null> => repoPatchNonConformity(params);

export const svcListActions = (filters: ListActionsQueryDTO): Promise<Paginated<QualityActionListItem>> => repoListActions(filters);

export const svcGetAction = (id: string): Promise<QualityActionDetail | null> => repoGetAction(id);

export const svcCreateAction = (params: { body: CreateActionBodyDTO; audit: AuditContext }): Promise<QualityActionDetail> =>
  repoCreateAction(params);

export const svcPatchAction = (params: { id: string; body: PatchActionBodyDTO; audit: AuditContext }): Promise<QualityActionDetail | null> =>
  repoPatchAction(params);

export const svcListDocuments = (entity_type: QualityEntityTypeDTO, entity_id: string): Promise<QualityDocument[]> =>
  repoListDocuments(entity_type, entity_id);

export const svcAttachDocuments = (params: {
  entity_type: QualityEntityTypeDTO;
  entity_id: string;
  document_type: QualityDocumentTypeDTO;
  documents: UploadedDocument[];
  audit: AuditContext;
}): Promise<QualityDocument[]> => repoAttachDocuments(params);

export const svcRemoveDocument = (params: {
  entity_type: QualityEntityTypeDTO;
  entity_id: string;
  doc_id: string;
  audit: AuditContext;
}): Promise<boolean> => repoRemoveDocument(params);

export const svcGetDocumentForDownload = (params: {
  entity_type: QualityEntityTypeDTO;
  entity_id: string;
  doc_id: string;
  audit: AuditContext;
}): Promise<QualityDocument | null> => repoGetDocumentForDownload(params);

export const svcQualityDocumentBaseDir = (): string => qualityDocumentBaseDir();
