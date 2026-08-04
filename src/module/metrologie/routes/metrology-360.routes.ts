import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";
import { requireMetrologyCapability } from "../middlewares/metrology-authorization.middleware";
import {
  cancelCertificate,
  cancelExecution,
  center,
  createEquipment,
  createExecution,
  createImpact,
  createPlan,
  decideImpactItem,
  downloadCertificate,
  equipmentTimeline,
  equipmentUsage,
  evaluateEligibility,
  getEquipment,
  getExecution,
  getImpact,
  listCategories,
  listEquipment,
  listExecutions,
  listImpacts,
  listUnits,
  previewVerdict,
  quarantineEquipment,
  recordMeasurements,
  revisePlan,
  schedulePreview,
  transitionEquipment,
  transitionImpact,
  transitionPlan,
  updateEquipment,
  uploadCertificate,
  upsertCategory,
  validateExecution,
} from "../controllers/metrology-360.controller";

/**
 * Surface Métrologie 360 (#229), montée sous `/metrologie/v2`.
 *
 * Chaque route déclare sa capacité fine — refus par défaut. Le routeur
 * historique `/metrologie` reste inchangé dans ses chemins pour ne casser aucun
 * écran en production ; il gagne seulement les mêmes gardes RBAC.
 */
const router = Router();
router.use(authenticateToken);

// Les fichiers transitent par un répertoire temporaire privé, jamais par le
// répertoire des documents avant d'avoir été contrôlés.
const upload = createSecureUpload("quality-document", { maxFiles: 1 });

/* Référentiels ------------------------------------------------------------ */
router.get("/categories", requireMetrologyCapability("read"), listCategories);
router.put("/categories", requireMetrologyCapability("categories_manage"), upsertCategory);
router.get("/units", requireMetrologyCapability("read"), listUnits);

/* Command center et éligibilité ------------------------------------------- */
router.get("/center", requireMetrologyCapability("read"), center);
router.get("/eligibility", requireMetrologyCapability("read"), evaluateEligibility);

/* Registre ---------------------------------------------------------------- */
router.get("/equipements", requireMetrologyCapability("read"), listEquipment);
router.post("/equipements", requireMetrologyCapability("equipment_write"), createEquipment);
router.get("/equipements/:id", requireMetrologyCapability("read"), getEquipment);
router.patch("/equipements/:id", requireMetrologyCapability("equipment_write"), updateEquipment);
router.get("/equipements/:id/timeline", requireMetrologyCapability("audit_read"), equipmentTimeline);
router.get("/equipements/:id/usage", requireMetrologyCapability("impact_read"), equipmentUsage);

// Mettre en quarantaine est un droit d'alerte largement ouvert ; en sortir ne
// l'est pas — la garde de sortie est rejouée dans le domaine.
router.post(
  "/equipements/:id/quarantine",
  requireMetrologyCapability("quarantine_set"),
  quarantineEquipment
);
router.post(
  "/equipements/:id/transitions",
  requireMetrologyCapability("repair_manage"),
  transitionEquipment
);

/* Plans ------------------------------------------------------------------- */
router.get("/equipements/:id/schedule-preview", requireMetrologyCapability("read"), schedulePreview);
router.post("/equipements/:id/plans", requireMetrologyCapability("plan_manage"), createPlan);
router.post(
  "/equipements/:id/plans/:childId/revisions",
  requireMetrologyCapability("plan_manage"),
  revisePlan
);
router.post(
  "/equipements/:id/plans/:childId/transitions",
  requireMetrologyCapability("plan_manage"),
  transitionPlan
);

/* Exécutions -------------------------------------------------------------- */
router.get("/executions", requireMetrologyCapability("read"), listExecutions);
router.get("/executions/:id", requireMetrologyCapability("read"), getExecution);
router.post(
  "/equipements/:id/executions",
  requireMetrologyCapability("execution_record"),
  createExecution
);
router.post(
  "/executions/:id/measurements",
  requireMetrologyCapability("execution_record"),
  recordMeasurements
);
router.get("/executions/:id/verdict-preview", requireMetrologyCapability("read"), previewVerdict);
// Valider le verdict est une capacité distincte de la saisie : l'opérateur
// d'atelier relève, la métrologie/qualité conclut.
router.post(
  "/executions/:id/validate",
  requireMetrologyCapability("verdict_validate"),
  validateExecution
);
router.post(
  "/executions/:id/cancel",
  requireMetrologyCapability("execution_record"),
  cancelExecution
);

/* Certificats et PV ------------------------------------------------------- */
router.post(
  "/equipements/:id/certificats",
  requireMetrologyCapability("documents_write"),
  upload.single("document"),
  uploadCertificate
);
router.post(
  "/equipements/:id/certificats/:childId/cancel",
  requireMetrologyCapability("documents_write"),
  cancelCertificate
);
router.get(
  "/equipements/:id/certificats/:childId/file",
  requireMetrologyCapability("documents_read"),
  downloadCertificate
);

/* Analyse d'impact -------------------------------------------------------- */
router.get("/impacts", requireMetrologyCapability("impact_read"), listImpacts);
router.get("/impacts/:id", requireMetrologyCapability("impact_read"), getImpact);
router.post("/equipements/:id/impacts", requireMetrologyCapability("impact_create"), createImpact);
router.post(
  "/impacts/:id/items/:childId/decision",
  requireMetrologyCapability("impact_decide"),
  decideImpactItem
);
router.post(
  "/impacts/:id/transitions",
  requireMetrologyCapability("impact_decide"),
  transitionImpact
);

export default router;
