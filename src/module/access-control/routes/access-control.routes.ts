// src/module/access-control/routes/access-control.routes.ts
import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import * as controller from "../controllers/access-control.controller";
import { requireSuperadmin } from "../middlewares/require-superadmin";

const router = Router();

// Aucun `authorizeRole` ici : le statut superadmin n'est pas un rôle métier et ne
// doit pas pouvoir être obtenu par une attribution de rôle depuis /admin/users.
router.use(authenticateToken, requireSuperadmin);

router.get("/overview", controller.getOverview);
router.get("/events", controller.getAccessEvents);
router.get("/reviews", controller.getAccessReviews);
router.post("/reviews", controller.postAccessReview);
router.get("/reviews/:reviewId", controller.getAccessReview);
router.put("/reviews/:reviewId/users/:userId/decision", controller.putAccessReviewDecision);
router.post("/reviews/:reviewId/close", controller.postCloseAccessReview);
router.put("/modules/:moduleKey/default", controller.putModuleDefault);
router.put("/users/:userId/modules/:moduleKey", controller.putUserModuleAccess);
router.put("/users/:userId/modules", controller.putUserModulesBulk);
router.post("/unlock-all", controller.postUnlockAll);

export default router;
