import { Router } from "express";

import { requireFinanceCapability } from "../facturation/middlewares/finance-authorization.middleware";
import {
  cancelAccountingBatch,
  createAccountingMapping,
  downloadAccountingArtifact,
  generateAccountingBatch,
  getAccountingBatch,
  listAccountingBatches,
  listAccountingMappings,
  previewAccountingBatch,
  reexportAccountingBatch,
  validateAccountingBatch,
} from "./accounting-export.controller";

const router = Router();

router.get("/mappings", requireFinanceCapability("accounting_export_read"), listAccountingMappings);
router.post("/mappings", requireFinanceCapability("accounting_export_admin"), createAccountingMapping);
router.get("/batches", requireFinanceCapability("accounting_export_read"), listAccountingBatches);
router.post("/batches/preview", requireFinanceCapability("accounting_export_execute"), previewAccountingBatch);
router.get("/batches/:id", requireFinanceCapability("accounting_export_read"), getAccountingBatch);
router.get("/batches/:id/artifact", requireFinanceCapability("accounting_export_read"), downloadAccountingArtifact);
router.post("/batches/:id/validate", requireFinanceCapability("accounting_export_execute"), validateAccountingBatch);
router.post("/batches/:id/generate", requireFinanceCapability("accounting_export_execute"), generateAccountingBatch);
router.post("/batches/:id/cancel", requireFinanceCapability("accounting_export_execute"), cancelAccountingBatch);
router.post("/batches/:id/reexport", requireFinanceCapability("accounting_export_execute"), reexportAccountingBatch);

export default router;
