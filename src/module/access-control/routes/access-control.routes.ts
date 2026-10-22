// src/module/access-control/routes/access-control.routes.ts
import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { requireRecentMfaForMutations } from "../../auth/middlewares/mfa-assurance.middleware";
import * as controller from "../controllers/access-control.controller";
import { requireSuperadmin } from "../middlewares/require-superadmin";
import { sharedDirectoryClient, sharedDirectorySite } from "../../../shared-directory/site-runtime";

const router = Router();

// Aucun `authorizeRole` ici : le statut superadmin n'est pas un rôle métier et ne
// doit pas pouvoir être obtenu par une attribution de rôle depuis /admin/users.
router.use(authenticateToken, requireSuperadmin, requireRecentMfaForMutations);
router.use((req,res,next)=>{
 const changesCommonRights=/^\/(?:users\/\d+\/(?:modules|sensitive-capabilities)(?:\/|$)|modules\/|unlock-all$)/.test(req.path);
 if(changesCommonRights&&!['GET','HEAD','OPTIONS'].includes(req.method)&&sharedDirectoryClient()&&sharedDirectorySite()!=='cerp_prod'){
  res.status(403).json({code:'COMMON_ACCESS_PRODUCTION_REQUIRED',message:'Les droits sont communs à toutes les bases. Modifiez-les depuis la Production.'});return;
 }
 next();
});

router.get("/overview", controller.getOverview);
router.get("/users/:userId/sensitive-capabilities", controller.getSensitiveCapabilities);
router.put("/users/:userId/sensitive-capabilities/:capability", controller.putSensitiveCapability);
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
