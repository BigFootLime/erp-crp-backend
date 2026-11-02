import { Router } from "express";
import * as controller from "../controllers/supplier-sandbox.controller";
import {
  authenticateSupplierSandbox,
  requireSupplierSandbox,
} from "../middlewares/supplier-sandbox.middleware";
const router = Router();
router.use(requireSupplierSandbox);
router.post("/auth/login", controller.login);
router.use(authenticateSupplierSandbox);
router.get("/purchase-lines", controller.lines);
router.post("/promise-proposals", controller.proposePromise);
export default router;
