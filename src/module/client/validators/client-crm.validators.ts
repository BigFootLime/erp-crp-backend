import { z } from "zod";
import { CRM_CHANNELS, CRM_CONTACT_POLICIES, CRM_CUSTOMER_KINDS, CRM_OUTCOMES,
  CRM_PURPOSES, CRM_RESCHEDULE_REASONS, CRM_STAGES } from "../types/client-crm.types";

// The canonical client key is varchar, including legacy imported identities.
export const crmClientIdSchema = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const crmIdempotencySchema = z.string().uuid().transform(value => value.toLowerCase());
const userId = z.number().int().positive().max(2147483647);
const version = z.number().int().positive().max(2147483646);
const timestamp = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), "Date invalide");
const note = z.string().trim().max(2000).nullable();
const contactId = z.string().uuid().nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Date invalide");

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("QUALIFY"), expected_version: version.or(z.literal(0)),
    customer_kind: z.enum(CRM_CUSTOMER_KINDS), stage: z.enum(CRM_STAGES), owner_user_id: userId.nullable(),
    contact_policy: z.enum(CRM_CONTACT_POLICIES), retention_review_date: date.nullable() }).strict(),
  z.object({ action: z.literal("PLAN"), expected_profile_version: version.or(z.literal(0)),
    contact_id: contactId, owner_user_id: userId, channel: z.enum(CRM_CHANNELS), purpose: z.enum(CRM_PURPOSES),
    title: z.string().trim().min(3).max(160).nullable(), due_at: timestamp }).strict(),
  z.object({ action: z.literal("RESCHEDULE"), followup_id: z.string().uuid(), expected_version: version,
    due_at: timestamp, owner_user_id: userId, reason: z.enum(CRM_RESCHEDULE_REASONS), note }).strict(),
  z.object({ action: z.literal("COMPLETE"), followup_id: z.string().uuid(), expected_version: version,
    outcome: z.enum(CRM_OUTCOMES), note }).strict(),
  z.object({ action: z.literal("CANCEL"), followup_id: z.string().uuid(), expected_version: version,
    reason: z.string().trim().min(3).max(500) }).strict(),
  z.object({ action: z.literal("LOG_INTERACTION"), contact_id: contactId, channel: z.enum(CRM_CHANNELS),
    outcome: z.enum(CRM_OUTCOMES), occurred_at: timestamp, note }).strict(),
]);
export const crmCommandSchema = command.superRefine((value, ctx) => {
  if (value.action === "PLAN" && value.purpose === "OTHER" && !value.title) {
    ctx.addIssue({ code: "custom", path: ["title"], message: "Précisez l’objet de la relance" });
  }
  if ((value.action === "COMPLETE" || value.action === "LOG_INTERACTION") && value.outcome === "OTHER"
    && (!value.note || value.note.length < 3)) {
    ctx.addIssue({ code: "custom", path: ["note"], message: "Précisez le résultat" });
  }
  if (value.action === "RESCHEDULE" && value.reason === "OTHER" && (!value.note || value.note.length < 3)) {
    ctx.addIssue({ code: "custom", path: ["note"], message: "Précisez le motif du report" });
  }
});
export const crmDetailQuerySchema = z.object({
  history_page: z.coerce.number().int().min(1).max(100000).default(1),
  followup_page: z.coerce.number().int().min(1).max(100000).default(1),
}).strict();
export const crmFollowupQuerySchema = z.object({
  scope: z.enum(["OVERDUE", "UPCOMING", "ALL"]).default("OVERDUE"),
  owner_user_id: z.coerce.number().int().positive().max(2147483647).optional(),
  client_id: crmClientIdSchema.optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export type CrmCommand = z.infer<typeof crmCommandSchema>;
export type CrmDetailQuery = z.infer<typeof crmDetailQuerySchema>;
export type CrmFollowupQuery = z.infer<typeof crmFollowupQuerySchema>;
