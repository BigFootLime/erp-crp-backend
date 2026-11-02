import { Router } from "express";

import { requireSuperadmin } from "../../access-control/middlewares/require-superadmin";
import { requireRecentMfaForMutations } from "../../auth/middlewares/mfa-assurance.middleware";
import * as controller from "../controllers/client-portal.controller";

const router = Router();

router.use(requireSuperadmin);
router.use(requireRecentMfaForMutations);
router.get("/accounts", controller.listAdminAccounts);
router.post("/accounts", controller.createAdminAccount);
router.post("/accounts/:accountId/invitations", controller.createAdminInvitation);
router.patch("/accounts/:accountId/status", controller.patchAdminAccountStatus);
router.post("/accounts/:accountId/delivery-sites", controller.createAdminDeliverySiteBinding);
router.post("/accounts/:accountId/contracts", controller.createAdminContractBinding);
router.get("/operational-notices", controller.listAdminOperationalNotices);
router.post("/operational-notices", controller.createAdminOperationalNotice);
router.get("/accounts/:accountId/demand-sites", controller.listAdminDemandSiteBindings);
router.post("/accounts/:accountId/demand-sites", controller.createAdminDemandSiteBinding);
router.post("/accounts/:accountId/demand-sites/revoke", controller.revokeAdminDemandSiteBinding);
router.get("/publications", controller.listAdminPublications);
router.post("/publications", controller.createAdminPublication);
router.post("/publications/:publicationId/revoke", controller.revokeAdminPublication);

export default router;

