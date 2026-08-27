import { Router } from "express";

import { requireFinanceCapability } from "../facturation/middlewares/finance-authorization.middleware";
import {
  approveSupplierInvoice,
  disputeSupplierInvoice,
  getSupplierInvoice,
  identifySupplierInvoice,
  listSupplierInvoices,
  matchSupplierInvoice,
  rejectSupplierInvoice,
  requestSupplierInvoiceApproval,
} from "./supplier-invoice.controller";

const router = Router();

router.get("/", requireFinanceCapability("supplier_invoice_read"), listSupplierInvoices);
router.get("/:id", requireFinanceCapability("supplier_invoice_read"), getSupplierInvoice);
router.post("/:id/identify", requireFinanceCapability("supplier_invoice_match"), identifySupplierInvoice);
router.post("/:id/match", requireFinanceCapability("supplier_invoice_match"), matchSupplierInvoice);
router.post("/:id/request-approval", requireFinanceCapability("supplier_invoice_match"), requestSupplierInvoiceApproval);
router.post("/:id/approve", requireFinanceCapability("supplier_invoice_approve"), approveSupplierInvoice);
router.post("/:id/dispute", requireFinanceCapability("supplier_invoice_dispute"), disputeSupplierInvoice);
router.post("/:id/reject", requireFinanceCapability("supplier_invoice_dispute"), rejectSupplierInvoice);

export default router;
