import type { RequestHandler } from "express";
import { z } from "zod";

const uuid = z.string().uuid();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Heure attendue au format HH:mm");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ");

const calendarFields = {
  code: z
    .string()
    .trim()
    .min(2)
    .max(30)
    .transform((value) => value.toUpperCase())
    .refine((value) => /^[A-Z0-9][A-Z0-9_-]+$/.test(value), "Code invalide"),
  label: z.string().trim().min(2, "Libellé requis").max(120),
  timezone: z.literal("Europe/Paris"),
  working_days: z
    .array(z.number().int().min(1).max(7))
    .min(1, "Sélectionnez au moins un jour")
    .refine((days) => new Set(days).size === days.length, "Un jour ne peut apparaître qu'une fois"),
  day_start: time,
  day_end: time,
  active: z.boolean(),
};

export const productionCalendarSchema = z
  .object(calendarFields)
  .superRefine((value, ctx) => {
    if (value.day_start >= value.day_end) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["day_end"], message: "La fin doit être après le début" });
    }
  });

export const updateProductionCalendarSchema = z
  .object({ ...calendarFields, expected_updated_at: z.string().datetime({ offset: true }) })
  .superRefine((value, ctx) => {
    if (value.day_start >= value.day_end) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["day_end"], message: "La fin doit être après le début" });
    }
  });

export const calendarIdParamSchema = z.object({ calendarId: uuid });
export const closureIdParamSchema = z.object({ calendarId: uuid, closureId: uuid });

export const productionCalendarClosureSchema = z
  .object({
    start_date: isoDate,
    end_date: isoDate,
    reason: z.string().trim().min(2, "Motif requis").max(200),
  })
  .refine((value) => value.start_date <= value.end_date, {
    path: ["end_date"],
    message: "La date de fin doit suivre la date de début",
  });

export type ProductionCalendarInput = z.infer<typeof productionCalendarSchema>;
export type UpdateProductionCalendarInput = z.infer<typeof updateProductionCalendarSchema>;
export type ProductionCalendarClosureInput = z.infer<typeof productionCalendarClosureSchema>;

export function validate(schema: z.ZodTypeAny, source: "body" | "params"): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      next(parsed.error);
      return;
    }
    req[source] = parsed.data;
    next();
  };
}
