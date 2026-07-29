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
  listCostCenterRates,
  listCostCenters,
  listMachineFamilies,
  listMachineOptions,
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

export default router;
