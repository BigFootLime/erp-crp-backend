import { z } from "zod";

const dateOnly = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD")
  .refine((value) => {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  }, "Date calendaire invalide");
const uuid = z.string().uuid();

export const stockIntelligenceOverviewQuerySchema = z.object({
  as_of: dateOnly.optional(),
  magasin_id: uuid.optional(),
  article_id: uuid.optional(),
  weeks: z.coerce.number().int().min(1).max(13).default(13),
  limit: z.coerce.number().int().min(1).max(500).default(200),
}).strict();

export const stockIntelligenceSimulationBodySchema = z.object({
  as_of: dateOnly.optional(),
  magasin_id: uuid,
  article_id: uuid,
  weeks: z.number().int().min(1).max(13).default(13),
  proposed_stock_qty: z.number().finite().positive().max(1_000_000_000),
  expected_receipt_date: dateOnly,
}).strict().superRefine((value, ctx) => {
  const floor = value.as_of ?? new Date().toISOString().slice(0, 10);
  if (value.expected_receipt_date < floor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expected_receipt_date"],
      message: "La réception simulée ne peut pas être antérieure à la date d'observation.",
    });
  }
});

export const stockIntelligencePolicyBodySchema = z.object({
  valid_from: dateOnly,
  abc_lookback_days: z.number().int().min(30).max(1095),
  abc_a_cumulative_pct: z.number().finite().gt(0).lt(100),
  abc_b_cumulative_pct: z.number().finite().gt(0).lte(100),
  dormant_after_days: z.number().int().min(1).max(3650),
  consumption_lookback_days: z.number().int().min(28).max(365),
  coverage_weeks: z.number().int().min(1).max(13),
  inventory_tolerance_pct: z.number().finite().min(0).max(100),
  inventory_absolute_tolerance_qty: z.number().finite().min(0).max(1_000_000_000),
  reason: z.string().trim().min(3).max(1000),
}).strict().superRefine((value, ctx) => {
  if (value.abc_a_cumulative_pct >= value.abc_b_cumulative_pct) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["abc_b_cumulative_pct"],
      message: "Le seuil B doit être strictement supérieur au seuil A.",
    });
  }
});

export type StockIntelligenceOverviewQueryDTO = z.infer<typeof stockIntelligenceOverviewQuerySchema>;
export type StockIntelligenceSimulationBodyDTO = z.infer<typeof stockIntelligenceSimulationBodySchema>;
export type StockIntelligencePolicyBodyDTO = z.infer<typeof stockIntelligencePolicyBodySchema>;
