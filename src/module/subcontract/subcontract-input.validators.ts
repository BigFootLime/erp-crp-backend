import { z } from "zod";

const uuid = z.string().uuid();
const unit = z.string().trim().min(1).max(32).transform((value) => value.toUpperCase());
const numericInput = z.union([
  z.number(),
  z.string().trim().min(1).refine((value) => Number.isFinite(Number(value)), "Nombre invalide"),
]).transform((value) => Number(value)).refine(Number.isFinite, "Nombre fini requis");
const quantity = numericInput.refine((value) => value > 0, "Quantité positive requise");

export const createSubcontractWorkPackageSchema = z.object({
  supplier_order_line_id: uuid,
  of_operation_id: uuid,
  ged_evidence_document_id: uuid,
  unit,
  qty_planned: quantity,
});

export const subcontractLedgerSchema = z.object({
  lot_id: uuid,
  unit,
  qty: quantity,
});

export const finaliseSubcontractWorkPackageSchema = z.object({
  expected_row_version: numericInput.refine((value) => Number.isInteger(value) && value > 0, "Version positive entière requise"),
  reason: z.string().trim().min(1).max(2_000),
});
