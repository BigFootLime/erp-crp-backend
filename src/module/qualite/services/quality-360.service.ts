// Service Qualité 360 (#228) — couche mince : la règle métier vit dans
// `domain/` et l'accès transactionnel dans `repository/`.

import {
  repoConsumeDerogation,
  repoCreateDerogation,
  repoCreateExecution,
  repoCreatePlan,
  repoDecideExecution,
  repoEvaluateEligibility,
  repoGetDerogation,
  repoGetExecution,
  repoGetNcAnalysis,
  repoGetPlan,
  repoListDerogations,
  repoListExecutions,
  repoListPlans,
  repoPlanApplicability,
  repoPreviewExecution,
  repoPreviewVerdict,
  repoQualityCenter,
  repoRecordMeasurements,
  repoRevisePlan,
  repoTransitionDerogation,
  repoTransitionNc,
  repoTransitionPlan,
  repoUpdatePlan,
  repoUpsertNcAnalysis,
} from "../repository/quality-360.repository";
import {
  repoCreateDeliveryPolicy,
  repoGetDeliveryPolicy,
  repoListDeliveryPolicies,
  repoReviseDeliveryPolicy,
  repoTransitionDeliveryPolicy,
  repoUpdateDeliveryPolicy,
} from "../repository/quality-delivery-policy.repository";

export const svcListDeliveryPolicies = repoListDeliveryPolicies;
export const svcGetDeliveryPolicy = repoGetDeliveryPolicy;
export const svcCreateDeliveryPolicy = repoCreateDeliveryPolicy;
export const svcUpdateDeliveryPolicy = repoUpdateDeliveryPolicy;
export const svcTransitionDeliveryPolicy = repoTransitionDeliveryPolicy;
export const svcReviseDeliveryPolicy = repoReviseDeliveryPolicy;

export const svcListPlans = repoListPlans;
export const svcGetPlan = repoGetPlan;
export const svcCreatePlan = repoCreatePlan;
export const svcUpdatePlan = repoUpdatePlan;
export const svcTransitionPlan = repoTransitionPlan;
export const svcRevisePlan = repoRevisePlan;
export const svcPlanApplicability = repoPlanApplicability;

export const svcListExecutions = repoListExecutions;
export const svcGetExecution = repoGetExecution;
export const svcPreviewExecution = repoPreviewExecution;
export const svcCreateExecution = repoCreateExecution;
export const svcRecordMeasurements = repoRecordMeasurements;
export const svcPreviewVerdict = repoPreviewVerdict;
export const svcDecideExecution = repoDecideExecution;

export const svcListDerogations = repoListDerogations;
export const svcGetDerogation = repoGetDerogation;
export const svcCreateDerogation = repoCreateDerogation;
export const svcTransitionDerogation = repoTransitionDerogation;
export const svcConsumeDerogation = repoConsumeDerogation;

export const svcGetNcAnalysis = repoGetNcAnalysis;
export const svcUpsertNcAnalysis = repoUpsertNcAnalysis;
export const svcTransitionNc = repoTransitionNc;

export const svcEvaluateEligibility = repoEvaluateEligibility;
export const svcQualityCenter = repoQualityCenter;
