import { z } from "zod";

const uuid = z.string().uuid();
const strictDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idempotencyKey = z.string().trim().min(8).max(200);

export const reminderIdParamsSchema = z.object({ id: uuid }).strict();
export const reminderFactureParamsSchema = z.object({ id: z.coerce.number().int().positive() }).strict();
export const reminderClientParamsSchema = z.object({ id: uuid }).strict();
export const reminderHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

export const createReminderPolicySchema = z.object({
  name: z.string().trim().min(3).max(120),
  timezone: z.string().trim().min(3).max(100).default("Europe/Paris"),
  channel: z.literal("EMAIL").default("EMAIL"),
  delivery_mode: z.enum(["MANUAL", "SANDBOX"]).default("MANUAL"),
  lawful_basis: z.enum(["CONTRACT", "LEGITIMATE_INTEREST", "CONSENT"]),
  consent_required: z.boolean().default(false),
  cadence_days: z.array(z.number().int().min(0).max(365)).min(1).max(12),
  retry_delays_minutes: z.array(z.number().int().min(1).max(10_080)).max(8).default([5, 30, 120]),
  template_subject: z.string().trim().min(1).max(200),
  template_body: z.string().trim().min(1).max(4_000),
  attach_invoice_pdf: z.boolean().default(true),
}).strict();

export const validateReminderPolicySchema = z.object({
  expected_version: z.number().int().positive(),
  confirmation: z.literal("VALIDER_POLITIQUE_RELANCES"),
  idempotency_key: idempotencyKey,
}).strict();

export const retireReminderPolicySchema = z.object({
  expected_version: z.number().int().positive(),
  reason: z.string().trim().min(5).max(500),
  idempotency_key: idempotencyKey,
}).strict();

export const listReminderSuggestionsSchema = z.object({
  status: z.enum([
    "SUGGESTED", "BLOCKED", "APPROVED", "CLAIMED", "SENT",
    "FAILED_RETRYABLE", "FAILED_FINAL", "CANCELLED",
  ]).optional(),
  facture_id: z.coerce.number().int().positive().optional(),
  client_id: uuid.optional(),
  from_due_date: strictDate.optional(),
  to_due_date: strictDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export const runReminderCycleSchema = z.object({
  now: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  idempotency_key: idempotencyKey,
}).strict();

export const approveReminderSchema = z.object({
  expected_version: z.number().int().positive(),
  confirmation: z.literal("APPROUVER_RELANCE"),
  idempotency_key: idempotencyKey,
}).strict();

export const sendReminderSchema = z.object({
  expected_version: z.number().int().positive(),
  idempotency_key: idempotencyKey,
}).strict();

export const retryReminderSchema = z.object({
  expected_version: z.number().int().positive(),
  confirmation: z.literal("REPRENDRE_RELANCE"),
  idempotency_key: idempotencyKey,
}).strict();

export const cancelReminderSchema = z.object({
  expected_version: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
  idempotency_key: idempotencyKey,
}).strict();

export const reminderClientPreferenceSchema = z.object({
  channel: z.enum(["EMAIL", "NONE"]),
  recipient_contact_id: uuid.nullable().default(null),
  opted_out: z.boolean(),
  restricted_processing: z.boolean().default(false),
  lawful_basis: z.enum(["CONTRACT", "LEGITIMATE_INTEREST", "CONSENT"]),
  consent_granted: z.boolean().nullable().default(null),
  consent_version: z.string().trim().min(1).max(80).nullable().default(null),
  consent_source: z.string().trim().min(1).max(120).nullable().default(null),
  expected_version: z.number().int().nonnegative(),
  idempotency_key: idempotencyKey,
}).strict().superRefine((value, ctx) => {
  if (value.lawful_basis === "CONSENT" && value.consent_granted === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["consent_granted"], message: "Le choix de consentement est requis." });
  }
  if (value.consent_granted !== null && (!value.consent_version || !value.consent_source)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["consent_version"], message: "La version et la source de consentement sont requises." });
  }
});

export type CreateReminderPolicyDTO = z.infer<typeof createReminderPolicySchema>;
export type ValidateReminderPolicyDTO = z.infer<typeof validateReminderPolicySchema>;
export type RetireReminderPolicyDTO = z.infer<typeof retireReminderPolicySchema>;
export type ListReminderSuggestionsDTO = z.infer<typeof listReminderSuggestionsSchema>;
export type RunReminderCycleDTO = z.infer<typeof runReminderCycleSchema>;
export type ApproveReminderDTO = z.infer<typeof approveReminderSchema>;
export type SendReminderDTO = z.infer<typeof sendReminderSchema>;
export type RetryReminderDTO = z.infer<typeof retryReminderSchema>;
export type CancelReminderDTO = z.infer<typeof cancelReminderSchema>;
export type ReminderClientPreferenceDTO = z.infer<typeof reminderClientPreferenceSchema>;
