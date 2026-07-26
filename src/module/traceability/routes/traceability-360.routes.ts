import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { requireTraceabilityCapability } from "../middlewares/traceability-authorization.middleware";
import {
  expandNode,
  getCapabilities,
  getChain,
  previewImpact,
  searchTraceability,
} from "../controllers/traceability-360.controller";

/**
 * Surface Traçabilité 360 (#142), montée sous `/traceability/v2`.
 *
 * Chaque route déclare sa capacité fine — refus par défaut. Le chemin
 * historique `/traceability/chain` reste inchangé pour ne casser aucun écran
 * en production ; il gagne seulement la même garde RBAC, qui lui manquait.
 *
 * Aucune route d'écriture : ce module ne modifie aucune donnée industrielle.
 */
const router = Router();
router.use(authenticateToken);

router.get("/capabilities", requireTraceabilityCapability("read"), getCapabilities);
router.get("/search", requireTraceabilityCapability("search"), searchTraceability);
router.get("/chain", requireTraceabilityCapability("read"), getChain);
router.get("/expand", requireTraceabilityCapability("read"), expandNode);
// Simuler un impact prépare une décision qualité : capacité distincte de la
// simple lecture de chaîne.
router.get("/impact", requireTraceabilityCapability("impact"), previewImpact);

export default router;
