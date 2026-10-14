import { Router, type RequestHandler } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { requireQualityCapability } from "../middlewares/quality-authorization.middleware";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { assertPaperAutocontrolScope } from "../domain/autocontrol-capture";
import { idParamSchema } from "../validators/quality-360.validators";
import { svcGetExecution } from "../services/quality-360.service";
import { attachControlDocuments, listControlDocuments, downloadControlDocument } from "../controllers/qualite.controller";
import {
  cancelEmptyExecution,
  consumeDerogation,
  assignQualityCause,
  createQualityCost,
  createDeliveryPolicy,
  createDerogation,
  createExecution,
  createPlan,
  decideExecution,
  evaluateEligibility,
  getDerogation,
  getDeliveryPolicy,
  getExecution,
  getNcAnalysis,
  getPlan,
  listDerogations,
  listDeliveryPolicies,
  listExecutions,
  listPlans,
  planApplicability,
  previewExecution,
  ofOperationExecutionContext,
  previewVerdict,
  qualityCenter,
  qualityIntelligence,
  qualityInvestigation,
  recordMeasurements,
  recordAutocontrolCapture,
  reviseDeliveryPolicy,
  revisePlan,
  transitionDerogation,
  transitionDeliveryPolicy,
  transitionNc,
  transitionPlan,
  updatePlan,
  updateDeliveryPolicy,
  upsertNcAnalysis,
} from "../controllers/quality-360.controller";

/**
 * Surface Qualité 360 (#228), montée sous `/qualite/v2`.
 *
 * Elle n'hérite PAS du garde global `requireQualityOrAdmin` du routeur
 * historique : chaque route déclare sa capacité fine, refus par défaut. Le
 * routeur historique reste inchangé pour ne casser aucun écran en production.
 */
const router = Router();
router.use(authenticateToken);
router.get('/of/:ofId/operations/:operationId/execution-context', requireQualityCapability('execution_run'), ofOperationExecutionContext);

/**
 * La capacité exigée dépend de la transition demandée : soumettre relève du
 * demandeur, approuver/refuser/révoquer de l'approbateur. Le corps est relu par
 * le validateur puis par le domaine ; ce garde n'est qu'un premier filtre.
 */
const requireDerogationTransitionCapability: RequestHandler = (req, res, next) => {
  const target = (req.body as { target_status?: unknown } | undefined)?.target_status;
  const capability =
    target === "SUBMITTED" || target === "DRAFT" ? "derogation_request" : "derogation_approve";
  requireQualityCapability(capability)(req, res, next);
};

// Centre Qualité et éligibilité (lecture).
router.get("/center", requireQualityCapability("read"), qualityCenter);
router.get("/eligibility", requireQualityCapability("read"), evaluateEligibility);
router.get("/intelligence", requireQualityCapability("analytics_read"), qualityIntelligence);
router.get("/intelligence/investigation", requireQualityCapability("analytics_read"), qualityInvestigation);
router.post("/intelligence/costs", requireQualityCapability("capa_manage"), createQualityCost);

// Politique globale de liberation des BL : aucune valeur par defaut n'est creee.
router.get("/delivery-release-policies", requireQualityCapability("read"), listDeliveryPolicies);
router.get("/delivery-release-policies/:id", requireQualityCapability("read"), getDeliveryPolicy);
router.post("/delivery-release-policies", requireQualityCapability("settings_manage"), createDeliveryPolicy);
router.patch("/delivery-release-policies/:id", requireQualityCapability("settings_manage"), updateDeliveryPolicy);
router.post("/delivery-release-policies/:id/revisions", requireQualityCapability("settings_manage"), reviseDeliveryPolicy);
router.post("/delivery-release-policies/:id/transitions", requireQualityCapability("settings_manage"), transitionDeliveryPolicy);

// Plans de contrôle.
router.get("/plans", requireQualityCapability("read"), listPlans);
router.get("/plans/applicability", requireQualityCapability("read"), planApplicability);
router.get("/plans/:id", requireQualityCapability("read"), getPlan);
router.post("/plans", requireQualityCapability("referential_manage"), createPlan);
router.patch("/plans/:id", requireQualityCapability("referential_manage"), updatePlan);
router.post("/plans/:id/revisions", requireQualityCapability("referential_manage"), revisePlan);
// Publier/archiver est une capacité distincte de l'édition du référentiel.
router.post("/plans/:id/transitions", requireQualityCapability("plan_publish"), transitionPlan);

// Exécutions de contrôle.
router.get("/executions", requireQualityCapability("read"), listExecutions);
router.get("/executions/:id", requireQualityCapability("read"), getExecution);
router.post("/executions/preview", requireQualityCapability("execution_run"), previewExecution);
router.post("/executions", requireQualityCapability("execution_run"), createExecution);
router.post(
  "/executions/:id/measurements",
  requireQualityCapability("measurement_write"),
  recordMeasurements
);
router.get("/executions/:id/verdict-preview", requireQualityCapability("read"), previewVerdict);
const paperUpload = createSecureUpload("quality-document");
const requireAutocontrol: RequestHandler = asyncHandler(async (req, _res, next) => {
  const { params } = idParamSchema.parse({ params: req.params });
  const execution = await svcGetExecution(params.id);
  if (!execution) throw new HttpError(404, "NOT_FOUND", "Contrôle introuvable.");
  assertPaperAutocontrolScope(execution);
  next();
});
const requireOpenAutocontrol: RequestHandler = asyncHandler(async (req, _res, next) => {
  const { params } = idParamSchema.parse({ params: req.params });
  const execution = await svcGetExecution(params.id);
  if (!execution) throw new HttpError(404, "NOT_FOUND", "Contrôle introuvable.");
  assertPaperAutocontrolScope(execution);
  if (execution.validation_date || execution.status === "CANCELLED") throw new HttpError(409, "QUALITY_EXECUTION_CLOSED", "Ce contrôle est déjà décidé.");
  next();
});
router.get("/executions/:id/paper-documents", requireQualityCapability("read"), requireAutocontrol, listControlDocuments);
router.get("/executions/:id/paper-documents/:docId/file", requireQualityCapability("read"), requireAutocontrol, downloadControlDocument);
router.post("/executions/:id/paper-documents", requireQualityCapability("measurement_write"), requireOpenAutocontrol,
  paperUpload.array("documents[]", 1), attachControlDocuments);
router.post("/executions/:id/autocontrol-capture", requireQualityCapability("measurement_write"), recordAutocontrolCapture);
// La décision de libération est séparée de la saisie de mesure.
router.post("/executions/:id/decision", requireQualityCapability("release_decide"), decideExecution);
router.post('/executions/:id/cancel-empty', requireQualityCapability('release_decide'), cancelEmptyExecution);

// Dérogations / concessions.
router.get("/derogations", requireQualityCapability("read"), listDerogations);
router.get("/derogations/:id", requireQualityCapability("read"), getDerogation);
router.post("/derogations", requireQualityCapability("derogation_request"), createDerogation);
// Soumettre est un droit de demandeur ; approuver/refuser/révoquer non.
router.post(
  "/derogations/:id/transitions",
  requireDerogationTransitionCapability,
  transitionDerogation
);
router.post(
  "/derogations/:id/consumptions",
  requireQualityCapability("release_decide"),
  consumeDerogation
);

// Non-conformités : analyse guidée et cycle de vie étendu.
router.get("/non-conformities/:id/analysis", requireQualityCapability("read"), getNcAnalysis);
router.put("/non-conformities/:id/analysis", requireQualityCapability("nc_manage"), upsertNcAnalysis);
router.post("/non-conformities/:id/transitions", requireQualityCapability("nc_manage"), transitionNc);
router.put("/non-conformities/:id/cause", requireQualityCapability("nc_manage"), assignQualityCause);

export default router;
