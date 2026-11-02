import { Router } from "express";
import { authenticateToken,authorizeRole } from "../../auth/middlewares/auth.middleware";
import { requireNamedSupplierPortalAdministrator,requireSupplierPortalPilot } from "../middlewares/supplier-portal.middleware";
import * as controller from "../controllers/supplier-portal-admin.controller";
const router=Router();router.use(requireSupplierPortalPilot,authenticateToken,authorizeRole("Administrateur Systeme et Reseau","Directeur","Achats","Responsable Achats"),requireNamedSupplierPortalAdministrator);
router.get("/access",controller.access);router.post("/invites",controller.invite);router.post("/accounts/:id/reset",controller.reset);router.post("/access/:id/disable",controller.disable);router.get("/promise-reviews",controller.reviews);router.post("/promise-reviews/:id/decision",controller.decision);
export default router;
