import {
  repoCancelAccountingBatch,
  repoCreateAccountingMapping,
  repoCreateAccountingPreview,
  repoDownloadAccountingArtifact,
  repoGenerateAccountingBatch,
  repoGetAccountingBatch,
  repoListAccountingBatches,
  repoListAccountingMappings,
  repoReexportAccountingBatch,
  repoValidateAccountingBatch,
} from "./accounting-export.repository";

export const accountingExportService = {
  listMappings: repoListAccountingMappings,
  createMapping: repoCreateAccountingMapping,
  listBatches: repoListAccountingBatches,
  getBatch: repoGetAccountingBatch,
  preview: repoCreateAccountingPreview,
  validate: repoValidateAccountingBatch,
  generate: repoGenerateAccountingBatch,
  cancel: repoCancelAccountingBatch,
  reexport: repoReexportAccountingBatch,
  download: repoDownloadAccountingArtifact,
};
