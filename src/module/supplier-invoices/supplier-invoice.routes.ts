import { Router } from "express";
import type { RequestHandler } from 'express';
import { HttpError } from '../../utils/httpError';
import { canUseMarginCapability } from '../margin-engine/domain/margin-engine-policy';

import { requireFinanceCapability } from "../facturation/middlewares/finance-authorization.middleware";
import {
  approveSupplierInvoice,
  disputeSupplierInvoice,
  getSupplierInvoice,
  getSupplierInvoiceHeaderAllocation,
  getSupplierInvoiceMaterialReconciliation,
  confirmSupplierInvoiceMaterialReconciliation,
  identifySupplierInvoice,
  listSupplierInvoices,
  matchSupplierInvoice,
  rejectSupplierInvoice,
  requestSupplierInvoiceApproval,
} from "./supplier-invoice.controller";

const router = Router();
const requireMaterialFinancialWrite:RequestHandler=(req,_res,next)=>{
  if(!req.user)return next(new HttpError(401,'UNAUTHORIZED','Authentification requise.'));
  if(!canUseMarginCapability(req.user.role,'snapshot',false))return next(new HttpError(403,'MARGIN_CAPABILITY_REQUIRED','La capacité financière de validation est requise.'));
  next();
};

router.get("/", requireFinanceCapability("supplier_invoice_read"), listSupplierInvoices);
router.get("/:id", requireFinanceCapability("supplier_invoice_read"), getSupplierInvoice);
router.get('/:id/header-allocation',requireFinanceCapability('supplier_invoice_read'),getSupplierInvoiceHeaderAllocation);
router.get('/:id/material-reconciliation',requireFinanceCapability('supplier_invoice_read'),getSupplierInvoiceMaterialReconciliation);
router.post('/:id/material-reconciliation',requireFinanceCapability('supplier_invoice_approve'),requireMaterialFinancialWrite,confirmSupplierInvoiceMaterialReconciliation);
router.post("/:id/identify", requireFinanceCapability("supplier_invoice_match"), identifySupplierInvoice);
router.post("/:id/match", requireFinanceCapability("supplier_invoice_match"), matchSupplierInvoice);
router.post("/:id/request-approval", requireFinanceCapability("supplier_invoice_match"), requestSupplierInvoiceApproval);
router.post("/:id/approve", requireFinanceCapability("supplier_invoice_approve"), approveSupplierInvoice);
router.post("/:id/dispute", requireFinanceCapability("supplier_invoice_dispute"), disputeSupplierInvoice);
router.post("/:id/reject", requireFinanceCapability("supplier_invoice_dispute"), rejectSupplierInvoice);

export default router;
