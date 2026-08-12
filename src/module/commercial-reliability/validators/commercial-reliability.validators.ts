import { z } from "zod";
import {
  LOSS_REASON_CODES,
  ORDER_CANCELLATION_REASON_CODES,
  REMINDER_CHANNELS,
} from "../domain/commercial-reliability";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD");
const isoDateTime = z.string().datetime({ offset: true });
const boundedNote = z.string().trim().min(1).max(1000);

export const commercialOverviewQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  as_of: isoDate.optional(),
  client_id: z.string().trim().min(1).max(40).optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "Devise ISO 4217 attendue").transform((value) => value.toUpperCase()).optional(),
  commercial_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).superRefine((value, ctx) => {
  if (value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "La fin doit suivre le début." });
  }
  if (value.as_of && value.as_of < value.from) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["as_of"], message: "L'arrêté doit suivre le début." });
  }
});

export const commercialEntityIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const quoteReminderBodySchema = z.object({
  channel: z.enum(REMINDER_CHANNELS),
  occurred_at: isoDateTime.optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  note: boundedNote.optional(),
});

export const quoteLossBodySchema = z.object({
  reason_code: z.enum(LOSS_REASON_CODES),
  occurred_at: isoDateTime.optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  note: boundedNote.optional(),
});

export const discountRequestBodySchema = z.object({
  note: boundedNote.optional(),
});

export const discountDecisionBodySchema = z.object({
  approval_request_id: z.string().uuid(),
  decision: z.enum(["APPROVE", "REJECT"]),
  note: boundedNote,
});

export const expireDueQuotesBodySchema = z.object({
  as_of: isoDate,
  limit: z.number().int().min(1).max(500).default(100),
});

export const cancelOrderBodySchema = z.object({
  reason_code: z.enum(ORDER_CANCELLATION_REASON_CODES),
  note: boundedNote.optional(),
});

export type CommercialOverviewQueryDTO = z.infer<typeof commercialOverviewQuerySchema>;
export type QuoteReminderBodyDTO = z.infer<typeof quoteReminderBodySchema>;
export type QuoteLossBodyDTO = z.infer<typeof quoteLossBodySchema>;
export type DiscountRequestBodyDTO = z.infer<typeof discountRequestBodySchema>;
export type DiscountDecisionBodyDTO = z.infer<typeof discountDecisionBodySchema>;
export type ExpireDueQuotesBodyDTO = z.infer<typeof expireDueQuotesBodySchema>;
export type CancelOrderBodyDTO = z.infer<typeof cancelOrderBodySchema>;
