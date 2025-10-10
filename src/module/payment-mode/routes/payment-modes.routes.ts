// src/module/payment-modes/routes/payment-modes.routes.ts
import { Router } from "express";
import { listPaymentModes, postPaymentMode } from "../controllers/payment-modes.controller";

const router = Router();
router.get("/", listPaymentModes);
router.post("/", postPaymentMode);
export default router;
