import { Router } from "express";

import { requireSuperadmin } from "../../access-control/middlewares/require-superadmin";
import {
  getDashboardGovernance,
  getDashboardUsageMetrics,
  postDashboardUsage,
} from "../controllers/dashboard-governance.controller";

// Monté après authenticateToken dans v1.routes.ts. La configuration et le
// compteur sont accessibles à tout compte authentifié ; les agrégats restent
// réservés au superadmin et ne contiennent aucun identifiant individuel.
const router = Router();

router.get("/", getDashboardGovernance);
router.post("/usage", postDashboardUsage);
router.get("/metrics", requireSuperadmin, getDashboardUsageMetrics);

export default router;
