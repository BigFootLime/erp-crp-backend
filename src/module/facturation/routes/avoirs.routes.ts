import { Router } from "express";
import {
  createAvoir,
  deleteAvoir,
  generateAvoirPdf,
  getAvoir,
  getAvoirPdf,
  listAvoirs,
  updateAvoir,
} from "../controllers/avoirs.controller";
import { requireFinanceCapability } from "../middlewares/finance-authorization.middleware";
import {
  createAvoirDraftWorkflow,
  issueAvoirWorkflow,
  listAvoirEligibleLines,
  previewAvoirWorkflow,
  requestAvoirValidationWorkflow,
  validateAvoirWorkflow,
} from "../controllers/avoir-workflow.controller";

const router = Router();

router.get(
  "/workflow/invoices/:id/eligible-lines",
  requireFinanceCapability("read"),
  listAvoirEligibleLines
);
router.post("/workflow/preview", requireFinanceCapability("credit_write"), previewAvoirWorkflow);
router.post("/workflow/drafts", requireFinanceCapability("credit_write"), createAvoirDraftWorkflow);
router.post(
  "/workflow/:id/request-validation",
  requireFinanceCapability("request_validation"),
  requestAvoirValidationWorkflow
);
router.post(
  "/workflow/:id/validate",
  requireFinanceCapability("validate"),
  validateAvoirWorkflow
);
router.post("/workflow/:id/issue", requireFinanceCapability("credit_issue"), issueAvoirWorkflow);

router.get("/", requireFinanceCapability("read"), listAvoirs);
router.get("/:id", requireFinanceCapability("read"), getAvoir);
router.get("/:id/pdf", requireFinanceCapability("documents_read"), getAvoirPdf);
router.post("/", requireFinanceCapability("credit_write"), createAvoir);
router.post("/:id/pdf", requireFinanceCapability("credit_write"), generateAvoirPdf);
router.patch("/:id", requireFinanceCapability("credit_write"), updateAvoir);
router.delete("/:id", requireFinanceCapability("settings_manage"), deleteAvoir);

export default router;
