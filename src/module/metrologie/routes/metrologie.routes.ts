import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";
import { requireMetrologyCapability } from "../middlewares/metrology-authorization.middleware";
import {
  attachCertificats,
  createEquipement,
  deleteEquipement,
  downloadCertificatFile,
  getEquipement,
  listCertificats,
  listEquipements,
  metrologieAlerts,
  metrologieAlertsSummary,
  metrologieKpis,
  patchEquipement,
  removeCertificat,
  upsertPlan,
} from "../controllers/metrologie.controller";

const upload = createSecureUpload("quality-document");

/**
 * Routeur historique du module Métrologie.
 *
 * Les CHEMINS et les CONTRATS restent identiques : aucun écran en production
 * ne casse. En revanche, #229 corrige un risque réel — ces routes étaient
 * seulement authentifiées, sans aucune autorisation : n'importe quel compte
 * connecté pouvait créer, modifier ou supprimer un équipement de métrologie, et
 * télécharger un certificat. Elles déclarent désormais les mêmes capacités
 * fines que la surface v2.
 */
const router = Router();
router.use(authenticateToken);

router.get("/kpis", requireMetrologyCapability("read"), metrologieKpis);
router.get("/alerts/summary", requireMetrologyCapability("read"), metrologieAlertsSummary);
router.get("/alerts", requireMetrologyCapability("read"), metrologieAlerts);

router.get("/equipements", requireMetrologyCapability("read"), listEquipements);
router.post("/equipements", requireMetrologyCapability("equipment_write"), createEquipement);
router.get("/equipements/:id", requireMetrologyCapability("read"), getEquipement);
router.patch("/equipements/:id", requireMetrologyCapability("equipment_write"), patchEquipement);
// Le retrait logique d'un instrument est une décision de parc, pas une édition.
router.delete("/equipements/:id", requireMetrologyCapability("repair_manage"), deleteEquipement);

router.put("/equipements/:id/plan", requireMetrologyCapability("plan_manage"), upsertPlan);

router.get(
  "/equipements/:id/certificats",
  requireMetrologyCapability("documents_read"),
  listCertificats
);
router.post(
  "/equipements/:id/certificats",
  requireMetrologyCapability("documents_write"),
  upload.array("documents[]"),
  attachCertificats
);
router.delete(
  "/equipements/:id/certificats/:certificatId",
  requireMetrologyCapability("documents_write"),
  removeCertificat
);
router.get(
  "/equipements/:id/certificats/:certificatId/file",
  requireMetrologyCapability("documents_read"),
  downloadCertificatFile
);

export default router;
