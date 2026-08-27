import { z } from "zod";

const expectedVersion = z.number().int().positive();

export const eReportingTransactionBodySchema = z.discriminatedUnion("source_type", [
  z.object({
    source_type: z.literal("CUSTOMER_INVOICE"),
    source_id: z.coerce.number().int().positive(),
    expected_version: expectedVersion,
  }).strict(),
  z.object({
    source_type: z.literal("CUSTOMER_CREDIT_NOTE"),
    source_id: z.coerce.number().int().positive(),
    expected_version: expectedVersion,
  }).strict(),
  z.object({
    source_type: z.literal("SUPPLIER_INVOICE"),
    source_id: z.string().uuid(),
    expected_version: expectedVersion,
  }).strict(),
]);

export const eReportingPaymentBodySchema = z.object({
  paiement_id: z.number().int().positive(),
  facture_id: z.number().int().positive(),
  expected_version: z.number().int().positive(),
}).strict();

export const eReportingPeriodsQuerySchema = z.object({
  kind: z.enum(["TRANSACTION", "PAYMENT"]).optional(),
  role: z.enum(["SELLER", "BUYER"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

export type EReportingTransactionBody = z.infer<typeof eReportingTransactionBodySchema>;
export type EReportingPaymentBody = z.infer<typeof eReportingPaymentBodySchema>;
export type EReportingPeriodsQuery = z.infer<typeof eReportingPeriodsQuerySchema>;
