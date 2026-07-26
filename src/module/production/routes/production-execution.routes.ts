import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import {
  requireIdempotencyKey,
  requireProductionExecutionCapability,
} from "../middlewares/production-execution-authorization.middleware";
import {
  cancelExecution,
  capabilities,
  changeExecution,
  correctExecution,
  declareIncident,
  declareQuantity,
  executionCenter,
  executionIndicators,
  finishOperation,
  getExecution,
  listActivityCategories,
  listExecutions,
  operatorBoard,
  pauseExecution,
  previewFinishOperation,
  rejectExecution,
  resumeExecution,
  startExecution,
  stopExecution,
  submitExecution,
  validateExecution,
} from "../controllers/production-execution.controller";

/**
 * Surface « Suivi et pointage de production 360 » (#274), montée sous
 * `/production/execution`.
 *
 * Elle n'hérite d'aucune garde globale trop large : chaque route déclare sa
 * capacité fine, refus par défaut. Le routeur historique `production.routes.ts`
 * reste inchangé pour ne casser aucun écran en production, et ses routes
 * `time-logs` sont désormais servies par l'adaptateur de compatibilité qui
 * écrit dans ce moteur canonique.
 *
 * Toute commande à effet exige un en-tête `Idempotency-Key` : double-clic,
 * second onglet et retry réseau produisent exactement un effet.
 */
const router = Router();
router.use(authenticateToken);

/* ------------------------------- Lecture --------------------------------- */

// Référentiel d'activités : lisible par quiconque peut lire l'exécution, sinon
// le poste opérateur ne pourrait pas afficher ses boutons.
router.get("/activity-categories", requireProductionExecutionCapability("read"), listActivityCategories);

// Capacités de l'appelant : l'UI s'en sert pour n'AFFICHER que ce qui est
// autorisé — le backend re-vérifie systématiquement de toute façon.
router.get("/capabilities", capabilities);

router.get("/center", requireProductionExecutionCapability("read"), executionCenter);
router.get("/indicators", requireProductionExecutionCapability("read"), executionIndicators);
router.get("/operator-board", requireProductionExecutionCapability("read"), operatorBoard);
router.get("/", requireProductionExecutionCapability("read"), listExecutions);
router.get("/:id", requireProductionExecutionCapability("read"), getExecution);

/* ------------------------ Commandes de segment --------------------------- */

router.post(
  "/",
  requireIdempotencyKey,
  requireProductionExecutionCapability("start_self"),
  startExecution
);
router.post(
  "/:id/pause",
  requireIdempotencyKey,
  requireProductionExecutionCapability("pause_self"),
  pauseExecution
);
router.post(
  "/:id/resume",
  requireIdempotencyKey,
  requireProductionExecutionCapability("pause_self"),
  resumeExecution
);
// Changement d'activité, de machine, de poste ou d'opérateur : clôture le
// segment courant et en ouvre un nouveau, sans réécrire le passé.
router.post(
  "/:id/change",
  requireIdempotencyKey,
  requireProductionExecutionCapability("start_self"),
  changeExecution
);
router.post(
  "/:id/incidents",
  requireIdempotencyKey,
  requireProductionExecutionCapability("declare_incident"),
  declareIncident
);
router.post(
  "/:id/stop",
  requireIdempotencyKey,
  requireProductionExecutionCapability("stop_self"),
  stopExecution
);

/* ----------------------------- Quantités --------------------------------- */

router.post(
  "/quantities",
  requireIdempotencyKey,
  requireProductionExecutionCapability("declare_quantity"),
  declareQuantity
);

// Aperçu en LECTURE SEULE : aucune écriture, pas de clé d'idempotence exigée.
router.post(
  "/operations/finish/preview",
  requireProductionExecutionCapability("declare_quantity"),
  previewFinishOperation
);
// Confirmation : une seule transaction, aucun effet partiel possible.
router.post(
  "/operations/finish",
  requireIdempotencyKey,
  requireProductionExecutionCapability("declare_quantity"),
  finishOperation
);

/* ------------------------- Cycle de validation --------------------------- */

router.post("/:id/submit", requireProductionExecutionCapability("submit"), submitExecution);
// Valider, rejeter, corriger et annuler sont quatre capacités distinctes :
// l'atelier soumet, la hiérarchie tranche.
router.post("/:id/validate", requireProductionExecutionCapability("validate"), validateExecution);
router.post("/:id/reject", requireProductionExecutionCapability("reject"), rejectExecution);
router.post("/:id/correct", requireProductionExecutionCapability("correct"), correctExecution);
router.post("/:id/cancel", requireProductionExecutionCapability("cancel"), cancelExecution);

export default router;
