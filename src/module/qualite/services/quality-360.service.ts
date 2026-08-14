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
import {
  repoCreateQualityCost,
  repoAssignQualityCause,
  repoQualityIntelligence,
} from "../repository/quality-intelligence.repository";
import { svcGetTraceabilityChain } from "../../traceability/services/traceability-360.service";
import type { QualityInvestigationQueryDTO } from "../validators/quality-360.validators";

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
export const svcQualityIntelligence = repoQualityIntelligence;
export const svcCreateQualityCost = repoCreateQualityCost;
export const svcAssignQualityCause = repoAssignQualityCause;

export async function svcQualityInvestigation(params: {
  query: QualityInvestigationQueryDTO;
  role: string | null;
}) {
  const startedAt = performance.now();
  const graph = await svcGetTraceabilityChain({
    seed: { type: params.query.type, id: params.query.id },
    role: params.role,
    direction: "both",
    asOf: params.query.as_of ?? null,
    maxDepth: params.query.max_depth,
    maxNodes: 600,
    maxEdges: 2400,
    periodFrom: params.query.period_from ?? null,
    periodTo: params.query.period_to ?? null,
    withQualityAudit: true,
  });
  const materialTypes = new Set(["lot", "material_consumption", "reception_ligne", "stock_movement_line"]);
  const deliveryTypes = new Set(["bon_livraison", "bon_livraison_ligne", "delivery_proof"]);
  const materialNodes = graph.nodes.filter((node) => materialTypes.has(node.type));
  const deliveryNodes = graph.nodes.filter((node) => deliveryTypes.has(node.type));
  const provenEdges = graph.edges.filter((edge) => edge.proof_level === "proven").length;
  return {
    generated_at: new Date().toISOString(),
    generation_duration_ms: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
    definition: {
      label: "Dossier d'enquête matière → livraison",
      unit: "graphe de preuves",
      source: graph.sources,
      freshness: graph.as_of,
      reliability: graph.coverage.state,
    },
    coverage: {
      ...graph.coverage,
      material_node_count: materialNodes.length,
      delivery_node_count: deliveryNodes.length,
      material_to_delivery_available: materialNodes.length > 0 && deliveryNodes.length > 0,
      proven_edge_count: provenEdges,
      proven_edge_ratio: graph.edges.length > 0 ? Math.round((provenEdges / graph.edges.length) * 10_000) / 100 : null,
      missing_link_count: graph.data_quality_issues.length,
    },
    investigation_time: {
      value: null,
      unit: "minutes" as const,
      reliability: "UNAVAILABLE" as const,
      missing: ["investigation_started_at", "investigation_closed_at"] as const,
      source: [] as const,
    },
    graph,
  };
}
