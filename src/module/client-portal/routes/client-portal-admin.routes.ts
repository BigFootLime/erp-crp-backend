import { Router } from "express";

import { requireSuperadmin } from "../../access-control/middlewares/require-superadmin";
import * as controller from "../controllers/client-portal.controller";

const router = Router();

router.use(requireSuperadmin);
router.get("/accounts", controller.listAdminAccounts);
router.post("/accounts", controller.createAdminAccount);
router.post("/accounts/:accountId/invitations", controller.createAdminInvitation);
router.patch("/accounts/:accountId/status", controller.patchAdminAccountStatus);
router.get("/publications", controller.listAdminPublications);
router.post("/publications", controller.createAdminPublication);
router.post("/publications/:publicationId/revoke", controller.revokeAdminPublication);

export default router;

