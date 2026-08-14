import { Router } from "express";

import * as controller from "../controllers/client-portal.controller";
import { authenticateClientPortal } from "../middlewares/client-portal-auth.middleware";

const router = Router();

router.post("/auth/login", controller.login);
router.post("/auth/activate", controller.activate);
router.post("/auth/forgot-password", controller.forgotPassword);
router.post("/auth/reset-password", controller.resetPassword);

router.use(authenticateClientPortal);

router.get("/me", controller.me);
router.get("/orders", controller.listOrders);
router.get("/deliveries", controller.listDeliveries);
router.get("/invoices", controller.listInvoices);
router.get("/documents", controller.listDocuments);
router.get("/documents/:publicationId/download", controller.downloadDocument);
router.post("/documents/:publicationId/acknowledgements", controller.acknowledgeDocument);

export default router;

