import { Router } from "express";
import { createProforma, decideDeliveryPrepaymentTerms, getProforma, issueProforma,
  listProformas, previewExistingProforma, previewProforma,
  previewProformaChanges, refreshProforma, cancelProforma, assignProformaReceipts, releaseProformaReceipt } from "../controllers/proforma.controller";
import { requireFinanceCapability } from "../middlewares/finance-authorization.middleware";

const router = Router();
router.get("/", requireFinanceCapability("read"), listProformas);
router.post("/preview", requireFinanceCapability("draft_write"), previewProforma);
router.post("/", requireFinanceCapability("draft_write"), createProforma);
router.post("/affaires/:allocationId/terms", requireFinanceCapability("draft_write"), decideDeliveryPrepaymentTerms);
router.get("/:id", requireFinanceCapability("read"), getProforma);
router.get("/:id/preview", requireFinanceCapability("read"), previewExistingProforma);
router.post("/:id/preview", requireFinanceCapability("draft_write"), previewProformaChanges);
router.post("/:id/refresh", requireFinanceCapability("draft_write"), refreshProforma);
router.post("/:id/issue", requireFinanceCapability("issue"), issueProforma);
router.post("/:id/cancel", requireFinanceCapability("issue"), cancelProforma);
router.post("/:id/receipts", requireFinanceCapability("payment_allocate"), assignProformaReceipts);
router.post("/:id/receipts/:assignmentId/release", requireFinanceCapability("payment_allocate"), releaseProformaReceipt);
export default router;
