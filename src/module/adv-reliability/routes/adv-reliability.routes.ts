import { Router } from "express";

import { requireFinanceCapability } from "../../facturation/middlewares/finance-authorization.middleware";
import {
  advOrderChain,
  advOverview,
  createDeliveryBlock,
  createInvoiceDispute,
  createPaymentPromise,
  resolveDeliveryBlock,
  updateInvoiceDispute,
  updatePaymentPromise,
} from "../controllers/adv-reliability.controller";

const router = Router();

router.get("/overview", requireFinanceCapability("reporting_financial"), advOverview);
router.get("/orders/:id/chain", requireFinanceCapability("reporting_financial"), advOrderChain);
router.post("/deliveries/:id/blocks", requireFinanceCapability("draft_write"), createDeliveryBlock);
router.post("/delivery-blocks/:id/resolve", requireFinanceCapability("draft_write"), resolveDeliveryBlock);
router.post("/invoices/:id/payment-promises", requireFinanceCapability("payment_register"), createPaymentPromise);
router.post("/payment-promises/:id/status", requireFinanceCapability("payment_register"), updatePaymentPromise);
router.post("/invoices/:id/disputes", requireFinanceCapability("credit_write"), createInvoiceDispute);
router.post("/invoice-disputes/:id/status", requireFinanceCapability("credit_write"), updateInvoiceDispute);

export default router;
