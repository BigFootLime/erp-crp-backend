import { z } from "zod";

export const supplierInvoiceParamsSchema = z.object({ id: z.string().uuid() });

export const supplierInvoiceListQuerySchema = z.object({
  status: z.enum([
    "RECEIVED","IDENTIFIED","MATCHED","PENDING_APPROVAL","APPROVED",
    "ACCOUNTING_EXPORTED","CLOSED","DISPUTED","REJECTED",
  ]).optional(),
  fournisseur_id: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const supplierInvoiceMatchBodySchema = z.object({
  expected_version: z.number().int().positive(),
  mode: z.enum(["AUTO", "MANUAL"]),
  purchase_order_id: z.string().uuid().nullable().optional(),
  manual_justification: z.string().trim().min(3).max(1000).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.mode === "MANUAL" && !value.manual_justification) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manual_justification"], message: "Une justification est obligatoire pour le rapprochement manuel." });
  }
  if (value.mode === "AUTO" && value.manual_justification) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manual_justification"], message: "Le rapprochement automatique ne porte pas de justification manuelle." });
  }
});

export const supplierInvoiceIdentifyBodySchema = z.object({
  expected_version: z.number().int().positive(),
  fournisseur_id: z.string().uuid(),
});

export const supplierInvoiceVersionBodySchema = z.object({
  expected_version: z.number().int().positive(),
});

export const supplierInvoiceReasonBodySchema = supplierInvoiceVersionBodySchema.extend({
  reason: z.string().trim().min(3).max(1000),
});

export type SupplierInvoiceListQuery = z.infer<typeof supplierInvoiceListQuerySchema>;
export type SupplierInvoiceMatchBody = z.infer<typeof supplierInvoiceMatchBodySchema>;
export type SupplierInvoiceIdentifyBody = z.infer<typeof supplierInvoiceIdentifyBodySchema>;
export type SupplierInvoiceVersionBody = z.infer<typeof supplierInvoiceVersionBodySchema>;
export type SupplierInvoiceReasonBody = z.infer<typeof supplierInvoiceReasonBodySchema>;
