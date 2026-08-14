import { z } from "zod";

import {
  DELIVERY_BLOCK_CATEGORIES,
  INVOICE_DISPUTE_CATEGORIES,
  INVOICE_DISPUTE_STATUSES,
  PAYMENT_PROMISE_STATUSES,
} from "../domain/adv-reliability";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD");
const isoDateTime = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const positiveMoney = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/, "Montant positif avec deux décimales attendu")
  .refine((value) => value !== "0.00", "Le montant doit être strictement positif.");

export const advOverviewQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  as_of: isoDate.optional(),
  client_id: z.string().trim().min(1).max(40).optional(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).superRefine((value, ctx) => {
  if (value.from > value.to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "La fin doit suivre le début." });
  const days = Math.floor((Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000);
  if (days > 731) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "La période est limitée à 24 mois." });
});

export const orderParamsSchema = z.object({ id: z.coerce.number().int().positive() });
export const deliveryParamsSchema = z.object({ id: uuid });
export const invoiceParamsSchema = z.object({ id: z.coerce.number().int().positive() });
export const caseParamsSchema = z.object({ id: uuid });

export const deliveryBlockBodySchema = z.object({
  order_id: z.number().int().positive(),
  category: z.enum(DELIVERY_BLOCK_CATEGORIES),
  detail: z.string().trim().min(3).max(1000),
  owner_user_id: z.number().int().positive().nullable(),
  next_action: z.string().trim().min(3).max(500),
  due_date: isoDate,
});

export const resolveCaseBodySchema = z.object({
  resolution_note: z.string().trim().min(3).max(1000),
  expected_updated_at: isoDateTime,
});

export const paymentPromiseBodySchema = z.object({
  amount_ttc: positiveMoney,
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  promised_date: isoDate,
  owner_user_id: z.number().int().positive().nullable(),
  next_action: z.string().trim().min(3).max(500),
  due_date: isoDate,
  note: z.string().trim().min(3).max(1000).nullable().optional(),
});

export const paymentPromiseStatusBodySchema = z.object({
  status: z.enum(PAYMENT_PROMISE_STATUSES).exclude(["OPEN"]),
  resolution_note: z.string().trim().min(3).max(1000),
  expected_updated_at: isoDateTime,
});

export const invoiceDisputeBodySchema = z.object({
  category: z.enum(INVOICE_DISPUTE_CATEGORIES),
  disputed_amount_ttc: positiveMoney.nullable().optional(),
  owner_user_id: z.number().int().positive().nullable(),
  next_action: z.string().trim().min(3).max(500),
  due_date: isoDate,
  detail: z.string().trim().min(3).max(1000),
});

export const invoiceDisputeStatusBodySchema = z.object({
  status: z.enum(INVOICE_DISPUTE_STATUSES).exclude(["OPEN"]),
  resolution_note: z.string().trim().min(3).max(1000),
  expected_updated_at: isoDateTime,
});

export type AdvOverviewQueryDTO = z.infer<typeof advOverviewQuerySchema>;
export type DeliveryBlockBodyDTO = z.infer<typeof deliveryBlockBodySchema>;
export type ResolveCaseBodyDTO = z.infer<typeof resolveCaseBodySchema>;
export type PaymentPromiseBodyDTO = z.infer<typeof paymentPromiseBodySchema>;
export type PaymentPromiseStatusBodyDTO = z.infer<typeof paymentPromiseStatusBodySchema>;
export type InvoiceDisputeBodyDTO = z.infer<typeof invoiceDisputeBodySchema>;
export type InvoiceDisputeStatusBodyDTO = z.infer<typeof invoiceDisputeStatusBodySchema>;
