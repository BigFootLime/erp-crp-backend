import { z } from "zod";

import {
  PROCUREMENT_ANOMALY_STATUSES,
  PROCUREMENT_POLICY_SCOPE_TYPES,
  PROCUREMENT_PROMISE_REASON_CODES,
} from "../domain/procurement-reliability";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD");
const isoDateTime = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

export const procurementOverviewQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  as_of: isoDate.optional(),
  dimension: z.enum(["SUPPLIER", "ARTICLE", "FAMILY"]).default("SUPPLIER"),
  supplier_id: uuid.optional(),
  article_id: uuid.optional(),
  family_code: z.string().trim().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).superRefine((value, ctx) => {
  if (value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "La fin doit suivre le début." });
  }
  const days = Math.floor((Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000);
  if (days > 731) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "La période est limitée à 24 mois." });
  }
});

export const anomalyParamsSchema = z.object({ anomalyKey: z.string().regex(/^[A-Z_]+:[0-9a-f]{24}$/) });
export const purchaseOrderParamsSchema = z.object({ id: uuid });

export const anomalyActionBodySchema = z.object({
  owner_user_id: z.number().int().positive().nullable(),
  next_action: z.string().trim().min(3).max(500),
  due_date: isoDate,
  status: z.enum(PROCUREMENT_ANOMALY_STATUSES),
  resolution_note: z.string().trim().min(3).max(1000).nullable().optional(),
  expected_updated_at: isoDateTime.nullable().optional(),
}).superRefine((value, ctx) => {
  if (["RESOLVED", "DISMISSED"].includes(value.status) && !value.resolution_note) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resolution_note"], message: "Un motif est requis pour clore l'anomalie." });
  }
});

export const promisedDateBodySchema = z.object({
  line_id: uuid.nullable().optional(),
  promised_date: isoDate,
  reason_code: z.enum(PROCUREMENT_PROMISE_REASON_CODES).exclude(["SUPPLIER_ACKNOWLEDGEMENT"]),
  note: z.string().trim().min(3).max(1000).nullable().optional(),
  expected_updated_at: isoDateTime,
}).superRefine((value, ctx) => {
  if (value.reason_code === "OTHER" && !value.note) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "Une explication est requise pour le motif AUTRE." });
  }
});

export const procurementPolicyBodySchema = z.object({
  scope_type: z.enum(PROCUREMENT_POLICY_SCOPE_TYPES),
  scope_id: z.string().trim().min(1).max(80).nullable(),
  valid_from: isoDate,
  price_tolerance_pct: z.number().finite().min(0).max(100).nullable(),
  over_receipt_tolerance_pct: z.number().finite().min(0).max(100).default(0),
  lead_grace_days: z.number().int().min(0).max(365).default(0),
  reason: z.string().trim().min(3).max(1000),
}).superRefine((value, ctx) => {
  if (value.scope_type === "COMPANY" && value.scope_id !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope_id"], message: "Le périmètre société ne porte pas d'identifiant." });
  }
  if (value.scope_type !== "COMPANY" && value.scope_id === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope_id"], message: "Un identifiant de périmètre est requis." });
  }
});

export type ProcurementOverviewQueryDTO = z.infer<typeof procurementOverviewQuerySchema>;
export type AnomalyActionBodyDTO = z.infer<typeof anomalyActionBodySchema>;
export type PromisedDateBodyDTO = z.infer<typeof promisedDateBodySchema>;
export type ProcurementPolicyBodyDTO = z.infer<typeof procurementPolicyBodySchema>;
