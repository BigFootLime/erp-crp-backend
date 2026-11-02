import { z } from "zod";
export const industrialClient = z.string().trim().min(1).max(100);
export const industrialDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T12:00:00Z");
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === v;
  }, "Date civile invalide.");
export const industrialRunSchema = z
  .object({
    client_id: industrialClient,
    start: industrialDate,
    label: z.string().trim().min(1).max(160).default("Plan de référence"),
    capacity_percent: z.number().min(1).max(300).default(100),
    months: z.number().int().min(1).max(24).default(18),
    weeks: z
      .union([z.literal(4), z.literal(13), z.literal(26), z.literal(52)])
      .default(26),
  })
  .strict()
  .refine(
    (r) => r.weeks * 7 <= r.months * 28 + 31,
    "L’horizon PIC doit inclure le PDP.",
  );
export const industrialPolicySchema = z
  .object({
    client_id: industrialClient,
    expected_version: z.number().int().nonnegative(),
    auto_enabled: z.boolean(),
    risk_limit_eur: z.number().finite().nonnegative().max(1e12).nullable(),
    auto_ar_contact_id: z.string().uuid().nullable().optional(),
    transit_calendar_days: z
      .number()
      .int()
      .min(0)
      .max(180)
      .nullable()
      .optional(),
  })
  .strict();
const positive = z.number().finite().positive().max(1e9);
export const industrialSettingsSchema = z
  .object({
    client_id: industrialClient,
    articles: z
      .array(
        z
          .object({
            article_id: z.string().uuid(),
            family: z.string().trim().min(1).max(100),
            lead_days: z.number().int().min(0).max(730).nullable(),
            unit_cost_eur: positive.nullable(),
            // Omission means "do not review the yield".  In particular it
            // must not turn the database default of 100% into an approved
            // manufacturing assumption.
            yield_percent: positive.max(100).optional(),
            lot_size: positive.nullable(),
          })
          .strict(),
      )
      .max(500),
    contracts: z
      .array(
        z
          .object({
            contract_line_id: z.string().uuid(),
            min_stock: z.number().nonnegative().max(1e9),
            max_stock: z.number().nonnegative().max(1e9),
            committed_forecast: z.boolean(),
            use_history: z.boolean().optional(),
            risk_limit_eur: z.number().nonnegative().max(1e12).nullable(),
          })
          .strict()
          .refine(
            (r) => r.max_stock >= r.min_stock,
            "Le maximum est inférieur au minimum.",
          ),
      )
      .max(500),
  })
  .strict();
