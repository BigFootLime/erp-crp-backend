import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { requireTraceabilityCapability } from "../middlewares/traceability-authorization.middleware";

import { getLegacyChain } from "../controllers/traceability-360.controller";

/**
 * Routeur HISTORIQUE. Le chemin et la forme de la réponse sont conservés à
 * l'identique pour ne casser aucun écran déjà déployé ; l'implémentation est
 * recâblée sur le moteur #142 (donc sans N+1) et la route reçoit enfin la
 * garde RBAC `traceability.read` qui lui manquait — jusqu'ici, tout porteur
 * d'un JWT valide pouvait lire la chaîne complète devis → livraison.
 */
const router = Router();

router.use(authenticateToken);

router.get("/chain", requireTraceabilityCapability("read"), getLegacyChain);

export default router;
