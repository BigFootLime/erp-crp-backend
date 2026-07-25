import { Router } from "express";
import {
  createFacture,
  deleteFacture,
  generateFacturePdf,
  getFacture,
  getFacturePdf,
  listFactures,
  updateFacture,
} from "../controllers/factures.controller";
import {
  createFactureDraftWorkflow,
  issueFactureWorkflow,
  listEligibleFactureSources,
  previewFacture,
  requestFactureValidation,
  validateFactureWorkflow,
} from "../controllers/facture-workflow.controller";
import { requireFinanceCapability } from "../middlewares/finance-authorization.middleware";

const router = Router();

router.get(
  "/workflow/eligible-sources",
  requireFinanceCapability("read"),
  listEligibleFactureSources
);
router.post("/workflow/preview", requireFinanceCapability("draft_write"), previewFacture);
router.post("/workflow/drafts", requireFinanceCapability("draft_write"), createFactureDraftWorkflow);
router.post(
  "/workflow/:id/request-validation",
  requireFinanceCapability("request_validation"),
  requestFactureValidation
);
router.post(
  "/workflow/:id/validate",
  requireFinanceCapability("validate"),
  validateFactureWorkflow
);
router.post("/workflow/:id/issue", requireFinanceCapability("issue"), issueFactureWorkflow);

router.get("/", requireFinanceCapability("read"), listFactures);
router.get("/:id", requireFinanceCapability("read"), getFacture);
router.get("/:id/pdf", requireFinanceCapability("documents_read"), getFacturePdf);
router.post("/", requireFinanceCapability("draft_write"), createFacture);
router.post("/:id/pdf", requireFinanceCapability("draft_write"), generateFacturePdf);
router.patch("/:id", requireFinanceCapability("draft_write"), updateFacture);
router.delete("/:id", requireFinanceCapability("settings_manage"), deleteFacture);

export default router;
