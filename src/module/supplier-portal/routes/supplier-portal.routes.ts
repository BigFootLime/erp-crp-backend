import { Router } from "express";
import * as controller from "../controllers/supplier-portal.controller";
import { authenticateSupplierPortal,requireSupplierPortalPilot,supplierPortalAuthRateLimit } from "../middlewares/supplier-portal.middleware";
const router=Router();router.use(requireSupplierPortalPilot);
router.post("/auth/login",supplierPortalAuthRateLimit,controller.login);router.post("/auth/activate",supplierPortalAuthRateLimit,controller.activate);router.post("/auth/recover",supplierPortalAuthRateLimit,controller.recover);router.post("/auth/reset",supplierPortalAuthRateLimit,controller.reset);
router.use(authenticateSupplierPortal);router.get("/portal-context",controller.portalContext);router.get("/orders",controller.orders);router.put("/orders/:orderId/lines/:lineId/promise",controller.promise);
export default router;
