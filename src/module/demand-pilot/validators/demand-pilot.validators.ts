import { z } from "zod";
const key = z.string().trim().min(1).max(160);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const instant = new Date(v + "T12:00:00Z");
    return (
      v >= "1900-01-01" &&
      v < "2200-01-01" &&
      Number.isFinite(+instant) &&
      instant.toISOString().slice(0, 10) === v
    );
  }, "Date civile non planifiable.");
const demandQuantity = z
  .union([z.number(), z.string().regex(/^\d+(?:[.]\d{1,3})?$/)])
  .transform(Number)
  .refine(
    (q) => q > 0 && q <= 1_000_000_000 && Math.round(q * 1000) / 1000 === q,
    "Quantité positive avec trois décimales au plus.",
  );
const iso = z.string().datetime({ offset: true });
export const idempotencyKeySchema = z.string().uuid();
export const demandRowSchema = z
  .object({
    external_site: key.max(80),
    external_order_key: key,
    external_line_key: key,
    external_schedule_key: key,
    source_version: key,
    source_as_of: iso,
    kind: z.enum(["FIRM", "FORECAST"]),
    quantity: demandQuantity,
    unit: key.max(32),
    quantity_basis: z.enum(["TOTAL", "REMAINING"]).default("TOTAL"),
    need_date: date,
    customer_order_date: date.optional(),
    source_requested_date: date.optional(),
    source_confirmed_date: date.optional(),
    article_code: z.string().trim().max(160).optional().nullable(),
    article_id: z.string().uuid().optional().nullable(),
    contract_id: z.string().uuid().optional().nullable(),
    contract_line_id: z.string().uuid().optional().nullable(),
    contract_reference: z.string().trim().min(1).max(160).optional().nullable(),
    customer_reference: z.string().trim().max(200).optional().nullable(),
    comment: z.string().trim().max(4000).optional().nullable(),
  })
  .strict();
export const importSchema = z
  .object({
    client_id: z.string().trim().min(1).max(80).optional(),
    source_file_name: z.string().trim().max(255).optional().nullable(),
    complete_snapshot: z.boolean().default(false),
    rows: z.array(demandRowSchema).min(1).max(5000),
  })
  .strict();
/** Source rows are accepted only through the pure parser; they are never persisted before diagnostics are clean. */
export const rawImportSchema = z
  .object({
    client_id: z.string().trim().min(1).max(80).optional(),
    source_file_name: z.string().trim().max(255).optional().nullable(),
    complete_snapshot: z.boolean().default(false),
    source: z.enum(["VISION_SYSTEMS", "VISION_PROGRAMME", "GENERIC"]),
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
    first_data_row_number: z.coerce.number().int().min(1).optional(),
  })
  .strict();
export const previewSchema = z
  .object({
    client_id: z.string().trim().min(1).max(80).optional(),
    source: z.enum(["VISION_SYSTEMS", "VISION_PROGRAMME", "GENERIC"]),
    external_site: key,
    source_version: key,
    source_as_of: iso,
    sheet_name: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
export const listSchema = z.object({
  client_id: z.string().trim().min(1).max(80).optional(),
  status: z
    .enum([
      "PENDING",
      "REVIEW",
      "ACCEPTED",
      "REJECTED",
      "ACCEPTED_PENDING_MATERIALIZATION",
      "MATERIALIZED",
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});
export const decisionSchema = z
  .object({
    expected_version: z.coerce.number().int().positive(),
    action: z.enum(["ACCEPT", "REJECT", "REVIEW", "COUNTER"]),
    reason: z.string().trim().max(2000).optional().nullable(),
    scenario_code: z.string().trim().max(160).optional().nullable(),
    confirmed_need_date: date.optional().nullable(),
    planner_evidence: z
      .object({
        capacity_state: z.enum(["PROVEN", "UNKNOWN", "INFEASIBLE"]),
        cost_state: z.enum(["PROVEN", "UNKNOWN", "INFEASIBLE"]),
        blockers: z.array(z.string().max(400)).max(50).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();
export const portalResponseSchema = z
  .object({
    expected_version: z.coerce.number().int().positive(),
    response: z.enum(["ACKNOWLEDGE", "WITHDRAW", "COUNTERPROPOSE"]),
    counter_id: z.string().uuid().optional(),
    proposed_need_date: date.optional().nullable(),
    comment: z.string().trim().max(2000).optional().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.response === "COUNTERPROPOSE" && !value.proposed_need_date)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposed_need_date"],
        message: "Date proposée requise.",
      });
  });
