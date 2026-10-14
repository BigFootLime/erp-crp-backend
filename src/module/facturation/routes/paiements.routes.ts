import { Router } from "express";
import {
  createPaiement,
  deletePaiement,
  getPaiement,
  listPaiements,
  updatePaiement,
} from "../controllers/paiements.controller";
import {
  requireFinanceCapability,
  requirePaymentAllocationCapabilityForInlineAllocations,
} from "../middlewares/finance-authorization.middleware";
import {
  allocatePaymentWorkflow,
  registerPaymentWorkflow,
} from "../controllers/payment-workflow.controller";
import { previewCustomerRefund, registerCustomerRefund } from "../controllers/customer-refund.controller";

const router = Router();
router.post("/workflow/refunds/preview", requireFinanceCapability("payment_allocate"), previewCustomerRefund);
router.post("/workflow/refunds/register", requireFinanceCapability("payment_register"), requireFinanceCapability("payment_allocate"), registerCustomerRefund);

router.post(
  "/workflow/register",
  requireFinanceCapability("payment_register"),
  requirePaymentAllocationCapabilityForInlineAllocations,
  registerPaymentWorkflow
);
router.post(
  "/workflow/:id/allocations",
  requireFinanceCapability("payment_allocate"),
  allocatePaymentWorkflow
);

router.get("/", requireFinanceCapability("read"), listPaiements);
router.get("/:id", requireFinanceCapability("read"), getPaiement);
router.post("/", requireFinanceCapability("payment_register"), createPaiement);
router.patch("/:id", requireFinanceCapability("payment_register"), updatePaiement);
router.delete("/:id", requireFinanceCapability("settings_manage"), deletePaiement);

export default router;
