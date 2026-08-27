import { Router } from "express";

import { requireFinanceCapability } from "../middlewares/finance-authorization.middleware";
import {
  getElectronicInvoiceReferenceData,
  listElectronicInvoiceDirectory,
  searchElectronicInvoiceDirectory,
} from "./electronic-invoice-directory.controller";

const router = Router();

router.get("/reference-data", requireFinanceCapability("einvoice_read"), getElectronicInvoiceReferenceData);
router.get("/directory/companies", requireFinanceCapability("einvoice_read"), searchElectronicInvoiceDirectory);
router.get("/directory/entries", requireFinanceCapability("einvoice_read"), listElectronicInvoiceDirectory);

export default router;
