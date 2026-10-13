import { Router } from "express";
import { createProforma, decideDeliveryPrepaymentTerms, getProforma, issueProforma,
  listProformas, previewExistingProforma, previewProforma } from "../controllers/proforma.controller";
import { requireFinanceCapability } from "../middlewares/finance-authorization.middleware";

const router = Router();
router.get("/", requireFinanceCapability("read"), listProformas);
router.post("/preview", requireFinanceCapability("draft_write"), previewProforma);
router.post("/", requireFinanceCapability("draft_write"), createProforma);
router.post("/affaires/:allocationId/terms", requireFinanceCapability("draft_write"), decideDeliveryPrepaymentTerms);
router.get("/:id", requireFinanceCapability("read"), getProforma);
router.get("/:id/preview", requireFinanceCapability("read"), previewExistingProforma);
router.post("/:id/issue", requireFinanceCapability("issue"), issueProforma);
export default router;
