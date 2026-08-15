import { HttpError } from "../../../utils/httpError";
import { referenceDataCapabilitiesFor } from "../domain/reference-data-policy";
import {
  repoApplyReferenceChangeSet,
  repoCreateReferenceChangeSet,
  repoDecideReferenceChangeSet,
  repoExportReferenceData,
  repoGetReferenceChangeSet,
  repoListReferenceChangeSets,
  repoListReferenceRecords,
  repoPreviewReferenceChanges,
  repoReferenceCatalog,
} from "../repository/reference-data.repository";
import type { ReferenceDataAuditContext, ReferenceDatasetCode } from "../types/reference-data.types";
import type {
  CreateReferenceChangeSetInput,
  ReferenceDecisionInput,
  ReferencePreviewInput,
} from "../validators/reference-data.validators";

export const readReferenceDataCapabilitiesSVC = referenceDataCapabilitiesFor;
export const readReferenceDataCatalogSVC = repoReferenceCatalog;
export const listReferenceDataRecordsSVC = (datasetCode: ReferenceDatasetCode, limit: number) =>
  repoListReferenceRecords(datasetCode, limit);
export const previewReferenceDataChangesSVC = (input: ReferencePreviewInput) => repoPreviewReferenceChanges(input);
export const createReferenceDataChangeSetSVC = (input: CreateReferenceChangeSetInput, audit: ReferenceDataAuditContext) =>
  repoCreateReferenceChangeSet(input, audit);
export const listReferenceDataChangeSetsSVC = (params: { status?: string; limit: number }) =>
  repoListReferenceChangeSets(params);
export async function getReferenceDataChangeSetSVC(id: string) {
  const result = await repoGetReferenceChangeSet(id);
  if (!result) throw new HttpError(404, "REFERENCE_CHANGE_SET_NOT_FOUND", "Proposition introuvable.");
  return result;
}
export const decideReferenceDataChangeSetSVC = (
  id: string,
  input: ReferenceDecisionInput,
  audit: ReferenceDataAuditContext
) => repoDecideReferenceChangeSet(id, input, audit);
export const applyReferenceDataChangeSetSVC = (
  id: string,
  idempotencyKey: string,
  audit: ReferenceDataAuditContext
) => repoApplyReferenceChangeSet(id, idempotencyKey, audit);
export const exportReferenceDataSVC = (datasetCodes: ReferenceDatasetCode[]) => repoExportReferenceData(datasetCodes);
