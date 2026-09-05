import { repoProductionWorklist } from "../repository/production-worklist.repository";
import {
  repoPreparationWorkbench,
  repoReviewPreparationStock,
  repoSavePreparationDecisions,
  repoSelectPreparationVersion,
} from "../repository/production-preparation.repository";
import {
  repoDownloadSelfInspection,
  repoGenerateSelfInspection,
} from "../repository/self-inspection.repository";
export const svcProductionWorklist = repoProductionWorklist;
export const svcPreparationWorkbench = repoPreparationWorkbench;
export const svcReviewPreparationStock = repoReviewPreparationStock;
export const svcSavePreparationDecisions = repoSavePreparationDecisions;
export const svcSelectPreparationVersion = repoSelectPreparationVersion;
export const svcGenerateSelfInspection = repoGenerateSelfInspection;
export const svcDownloadSelfInspection = repoDownloadSelfInspection;
export { repoSynchronizePreparationChildren as svcSynchronizePreparationChildren } from "../repository/preparation-actions.repository";
export { repoReusePreparationStock as svcReusePreparationStock } from "../repository/preparation-stock-reuse.repository";
export {
  repoSaveProgrammingTask as svcSaveProgrammingTask,
  repoImportPreparationPurchases as svcImportPreparationPurchases,
} from "../repository/preparation-actions.repository";
export {
  repoPreviewConsolidation as svcPreviewConsolidation,
  repoCreateConsolidation as svcCreateConsolidation,
  repoGetConsolidation as svcGetConsolidation,
  repoDissolveConsolidation as svcDissolveConsolidation,
} from "../repository/production-consolidation.repository";

export { repoProductionWorkbenchConfig as svcProductionWorkbenchConfig } from "../repository/production-worklist.repository";
