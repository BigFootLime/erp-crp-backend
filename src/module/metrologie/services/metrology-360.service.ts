// Services Métrologie 360 (#229).
//
// Couche de délégation : elle expose une API stable aux contrôleurs et garde
// la règle métier dans le domaine et l'accès dans les dépôts. Aucune requête
// SQL ici, aucun objet Express non plus.

import {
  repoCancelCertificate,
  repoCancelExecution,
  repoCreateExecution,
  repoGetCertificateFile,
  repoGetExecution,
  repoListExecutions,
  repoPreviewVerdict,
  repoRecordMeasurements,
  repoUploadCertificate,
  repoValidateExecution,
  metrologyDocsBaseDir,
} from "../repository/metrology-execution.repository";
import {
  repoCreateImpact,
  repoDecideImpactItem,
  repoGetImpact,
  repoInstrumentUsage,
  repoListImpacts,
  repoTransitionImpact,
} from "../repository/metrology-impact.repository";
import {
  repoCenter,
  repoCreateEquipment,
  repoCreatePlanVersion,
  repoEvaluateEligibility,
  repoGetEquipmentDetail,
  repoListCategories,
  repoListEquipment,
  repoQuarantineEquipment,
  repoRevisePlanVersion,
  repoSchedulePreview,
  repoTimeline,
  repoTransitionEquipment,
  repoTransitionPlanVersion,
  repoUpdateEquipment,
  repoUpsertCategory,
} from "../repository/metrology-registry.repository";
import { listSupportedUnits } from "../domain/metrology-units";

export const svcListCategories = repoListCategories;
export const svcUpsertCategory = repoUpsertCategory;

export const svcListEquipment = repoListEquipment;
export const svcGetEquipmentDetail = repoGetEquipmentDetail;
export const svcCreateEquipment = repoCreateEquipment;
export const svcUpdateEquipment = repoUpdateEquipment;
export const svcTransitionEquipment = repoTransitionEquipment;
export const svcQuarantineEquipment = repoQuarantineEquipment;

export const svcCreatePlanVersion = repoCreatePlanVersion;
export const svcRevisePlanVersion = repoRevisePlanVersion;
export const svcTransitionPlanVersion = repoTransitionPlanVersion;
export const svcSchedulePreview = repoSchedulePreview;

export const svcCreateExecution = repoCreateExecution;
export const svcRecordMeasurements = repoRecordMeasurements;
export const svcPreviewVerdict = repoPreviewVerdict;
export const svcValidateExecution = repoValidateExecution;
export const svcCancelExecution = repoCancelExecution;
export const svcListExecutions = repoListExecutions;
export const svcGetExecution = repoGetExecution;

export const svcUploadCertificate = repoUploadCertificate;
export const svcCancelCertificate = repoCancelCertificate;
export const svcGetCertificateFile = repoGetCertificateFile;
export const svcMetrologyDocsBaseDir = metrologyDocsBaseDir;

export const svcCreateImpact = repoCreateImpact;
export const svcListImpacts = repoListImpacts;
export const svcGetImpact = repoGetImpact;
export const svcDecideImpactItem = repoDecideImpactItem;
export const svcTransitionImpact = repoTransitionImpact;
export const svcInstrumentUsage = repoInstrumentUsage;

export const svcEvaluateEligibility = repoEvaluateEligibility;
export const svcCenter = repoCenter;
export const svcTimeline = repoTimeline;

/** Référentiel d'unités supportées : la liste vient du serveur, pas de l'UI. */
export function svcListUnits() {
  return { items: listSupportedUnits() };
}
