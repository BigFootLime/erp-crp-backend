import { Router } from "express";
import { getPaymentModes, postPaymentMode } from "../controllers/payment-modes.controller";

const router = Router();
router.get("/", getPaymentModes);
router.post("/", postPaymentMode);

export default router;
