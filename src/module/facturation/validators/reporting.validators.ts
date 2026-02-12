import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date (expected YYYY-MM-DD)");

function coerceBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "y") return true;
    if (v === "false" || v === "0" || v === "no" || v === "n") return false;
  }
  return fallback;
}

export const revenueQuerySchema = z.object({
  granularity: z.enum(["week", "month", "year"]).optional().default("month"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  include_brouillon: z
    .preprocess((v) => coerceBool(v, false), z.boolean())
    .optional()
    .default(false),
});

export type RevenueQueryDTO = z.infer<typeof revenueQuerySchema>;

export const outstandingQuerySchema = z.object({
  as_of: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
  include_brouillon: z
    .preprocess((v) => coerceBool(v, false), z.boolean())
    .optional()
    .default(false),
});

export type OutstandingQueryDTO = z.infer<typeof outstandingQuerySchema>;

export const topClientsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
  include_brouillon: z
    .preprocess((v) => coerceBool(v, false), z.boolean())
    .optional()
    .default(false),
});

export type TopClientsQueryDTO = z.infer<typeof topClientsQuerySchema>;
