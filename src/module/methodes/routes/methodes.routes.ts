// Routeur Méthodes, monté sur /api/v1/methodes.
// Chaque route déclare sa capacité : refus par défaut, aucun droit implicite.
// `authenticateToken` et `moduleAccessGate` sont déjà appliqués globalement
// dans v1.routes.ts ; `/methodes` est rattaché au module d'accès
// « Données techniques » (module-catalog.ts).

import { Router } from "express";

import {
  addCostCenterRate,
  createCostCenter,
  createMachineFamily,
  getCostCenter,
  getMachineQualification,
  listCostCenterRates,
  listCostCenters,
  listMachineFamilies,
  listMachineOptions,
  listMachinesForQualification,
  previewMachineQualification,
  qualifyMachine,
  readMethodesCapabilities,
  updateCostCenter,
  updateMachineFamily,
} from "../controllers/methodes.controller";
import { requireMethodesCapability } from "../middlewares/methodes-authorization.middleware";
import {
  cfIdParamSchema,
  familyCodeParamSchema,
  listCostCentersQuerySchema,
  listFamiliesQuerySchema,
  listMachineOptionsQuerySchema,
  listMachinesQualificationQuerySchema,
  machineIdParamSchema,
  previewMachineQualificationQuerySchema,
  validate,
} from "../validators/methodes.validators";

const router = Router();

router.get("/capabilities", readMethodesCapabilities);

/* Familles machine — référentiel extensible. */
router.get(
  "/familles-machine",
  requireMethodesCapability("referentiel_read"),
  validate(listFamiliesQuerySchema, "query"),
  listMachineFamilies
);
router.post("/familles-machine", requireMethodesCapability("referentiel_write"), createMachineFamily);
router.patch(
  "/familles-machine/:code",
  requireMethodesCapability("referentiel_write"),
  validate(familyCodeParamSchema, "params"),
  updateMachineFamily
);

/* Centres de frais. */
router.get(
  "/centres-frais",
  requireMethodesCapability("referentiel_read"),
  validate(listCostCentersQuerySchema, "query"),
  listCostCenters
);
router.post("/centres-frais", requireMethodesCapability("referentiel_write"), createCostCenter);
router.get(
  "/centres-frais/:cfId",
  requireMethodesCapability("referentiel_read"),
  validate(cfIdParamSchema, "params"),
  getCostCenter
);
router.patch(
  "/centres-frais/:cfId",
  requireMethodesCapability("referentiel_write"),
  validate(cfIdParamSchema, "params"),
  updateCostCenter
);

/* Tarifs versionnés — lire un taux et poser un taux sont deux droits distincts. */
router.get(
  "/centres-frais/:cfId/taux",
  requireMethodesCapability("tarif_read"),
  validate(cfIdParamSchema, "params"),
  listCostCenterRates
);
router.post(
  "/centres-frais/:cfId/taux",
  requireMethodesCapability("tarif_write"),
  validate(cfIdParamSchema, "params"),
  addCostCenterRate
);

/* Sélecteur de machines de l'éditeur de gamme. */
router.get(
  "/machines",
  requireMethodesCapability("referentiel_read"),
  validate(listMachineOptionsQuerySchema, "query"),
  listMachineOptions
);

/* Qualification du parc machine (#233).
 * Déclaré APRÈS `/machines` et sur des chemins distincts : `/machines/parc` ne
 * peut pas être capturé comme un identifiant puisqu'il n'est pas un UUID, mais
 * l'ordre reste explicite pour qui relira ce fichier.
 * LIRE le parc relève du référentiel ; le QUALIFIER est un acte Méthodes
 * (`referentiel_write`), au même titre que créer une famille. */
router.get(
  "/machines/parc",
  requireMethodesCapability("referentiel_read"),
  validate(listMachinesQualificationQuerySchema, "query"),
  listMachinesForQualification
);
router.get(
  "/machines/:machineId/qualification",
  requireMethodesCapability("referentiel_read"),
  validate(machineIdParamSchema, "params"),
  getMachineQualification
);
// Aperçu d'impact AVANT décision : lecture seule, jamais d'écriture.
router.get(
  "/machines/:machineId/qualification/impact",
  requireMethodesCapability("referentiel_read"),
  validate(machineIdParamSchema, "params"),
  validate(previewMachineQualificationQuerySchema, "query"),
  previewMachineQualification
);
router.patch(
  "/machines/:machineId/qualification",
  requireMethodesCapability("referentiel_write"),
  validate(machineIdParamSchema, "params"),
  qualifyMachine
);

export default router;
