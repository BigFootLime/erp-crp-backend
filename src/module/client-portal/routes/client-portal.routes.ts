import { Router } from "express";
import { requireClientTransactions } from "../domain/transactional-rollout";

import * as controller from "../controllers/client-portal.controller";
import { authenticateClientPortal } from "../middlewares/client-portal-auth.middleware";

const router = Router();

router.post("/auth/login", controller.login);
router.post("/auth/activate", controller.activate);
router.post("/auth/forgot-password", controller.forgotPassword);
router.post("/auth/reset-password", controller.resetPassword);

router.use(authenticateClientPortal);

router.get("/me", controller.me);
router.get("/commercial-overview", controller.commercialOverview);
router.get("/orders", controller.listOrders);
router.get("/deliveries", controller.listDeliveries);
router.get("/deliveries/dashboard", controller.deliveryDashboard);
router.post("/deliveries/:deliveryId/receipt", requireClientTransactions, controller.confirmDeliveryReceipt);
router.get("/invoices", controller.listInvoices);
router.get("/documents", controller.listDocuments);
router.get("/documents/:publicationId/download", controller.downloadDocument);
router.post("/documents/:publicationId/acknowledgements", controller.acknowledgeDocument);

export default router;

