import type { RequestHandler } from "express";
import { z } from "zod";

import { REFERENCE_DATASET_CODES } from "../types/reference-data.types";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Heure attendue au format HH:mm");
const currency = z.string().trim().length(3).transform((value) => value.toUpperCase());
const idempotencyKey = z.string().trim().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/);

const hourlyRateChange = z.object({
  dataset_code: z.literal("HOURLY_RATES"),
  record_key: uuid,
  value: z.object({ amount: z.number().finite().positive().max(100_000), currency }),
}).strict();

const productionCalendarChange = z.object({
  dataset_code: z.literal("PRODUCTION_CALENDARS"),
  record_key: z.union([uuid, z.string().trim().min(2).max(30).regex(/^[A-Z0-9][A-Z0-9_-]+$/)]),
  value: z.object({
    code: z.string().trim().min(2).max(30).transform((value) => value.toUpperCase())
      .refine((value) => /^[A-Z0-9][A-Z0-9_-]+$/.test(value), "Code invalide"),
    label: z.string().trim().min(2).max(120),
    timezone: z.literal("Europe/Paris"),
    working_days: z.array(z.number().int().min(1).max(7)).min(1)
      .refine((days) => new Set(days).size === days.length, "Un jour ne peut apparaître qu'une fois"),
    day_start: time,
    day_end: time,
    active: z.boolean(),
  }).strict().refine((value) => value.day_start < value.day_end, { path: ["day_end"], message: "La fin doit suivre le début" }),
}).strict();

const materialCostChange = z.object({
  dataset_code: z.literal("MATERIAL_COSTS"),
  record_key: uuid,
  value: z.object({ unit_price: z.number().finite().nonnegative().max(1_000_000_000), currency }).strict(),
}).strict();

const unitConversionChange = z.object({
  dataset_code: z.literal("UNIT_CONVERSIONS"),
  record_key: uuid,
  value: z.object({
    purchase_unit: z.string().trim().min(1).max(20),
    stock_unit: z.string().trim().min(1).max(20),
    factor: z.number().finite().positive().max(1_000_000),
  }).strict().refine(
    (value) => value.purchase_unit.toLowerCase() !== value.stock_unit.toLowerCase() || value.factor === 1,
    { path: ["factor"], message: "Une conversion d'une unité vers elle-même doit avoir un facteur égal à 1." }
  ),
}).strict();

const supplierLeadTimeChange = z.object({
  dataset_code: z.literal("SUPPLIER_LEAD_TIMES"),
  record_key: uuid,
  value: z.object({ lead_time_days: z.number().int().min(0).max(3650) }).strict(),
}).strict();

const stockValuationChange = z.object({
  dataset_code: z.literal("STOCK_VALUATION"),
  record_key: z.literal("stock.valuation_method"),
  value: z.object({ method: z.enum(["WEIGHTED_AVERAGE", "FIFO", "SPECIFIC_IDENTIFICATION"]) }).strict(),
}).strict();

export const referenceChangeSchema = z.discriminatedUnion("dataset_code", [
  hourlyRateChange,
  productionCalendarChange,
  materialCostChange,
  unitConversionChange,
  supplierLeadTimeChange,
  stockValuationChange,
]);

const changeSetFields = {
  effective_from: isoDate,
  effective_to: isoDate.nullable().optional().default(null),
  reason: z.string().trim().min(5).max(2000),
  source: z.string().trim().min(3).max(500),
  reliability: z.enum(["DECLARED", "VERIFIED"]),
  changes: z.array(referenceChangeSchema).min(1).max(200)
    .refine((items) => new Set(items.map((item) => `${item.dataset_code}:${item.record_key}`)).size === items.length, {
      message: "Un même enregistrement ne peut apparaître qu'une fois par jeu de changements.",
    }),
};

function periodIsValid(value: { effective_from: string; effective_to?: string | null }): boolean {
  return value.effective_to == null || value.effective_to >= value.effective_from;
}

export const referencePreviewSchema = z.object(changeSetFields).strict().refine(periodIsValid, {
  path: ["effective_to"], message: "La date de fin doit suivre la date d'effet.",
});

export const createReferenceChangeSetSchema = z.object({ idempotency_key: idempotencyKey, ...changeSetFields })
  .strict().refine(periodIsValid, { path: ["effective_to"], message: "La date de fin doit suivre la date d'effet." });

export const referenceDecisionSchema = z.object({
  idempotency_key: idempotencyKey,
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().trim().min(5).max(1000),
}).strict();

export const referenceApplySchema = z.object({ idempotency_key: idempotencyKey }).strict();
export const changeSetIdParamSchema = z.object({ changeSetId: uuid });
export const datasetCodeParamSchema = z.object({ datasetCode: z.enum(REFERENCE_DATASET_CODES) });
export const listReferenceRecordsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
export const listReferenceChangesQuerySchema = z.object({
  status: z.enum(["PENDING_APPROVAL", "APPROVED", "REJECTED", "APPLIED", "FAILED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const referenceExportQuerySchema = z.object({
  datasets: z.string().trim().optional().transform((value, ctx) => {
    if (!value) return [...REFERENCE_DATASET_CODES];
    const codes = [...new Set(value.split(",").map((code) => code.trim()).filter(Boolean))];
    const invalid = codes.filter((code) => !REFERENCE_DATASET_CODES.includes(code as (typeof REFERENCE_DATASET_CODES)[number]));
    if (invalid.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Référentiels inconnus : ${invalid.join(", ")}` });
      return z.NEVER;
    }
    return codes as Array<(typeof REFERENCE_DATASET_CODES)[number]>;
  }),
});

export type ReferencePreviewInput = z.infer<typeof referencePreviewSchema>;
export type CreateReferenceChangeSetInput = z.infer<typeof createReferenceChangeSetSchema>;
export type ReferenceDecisionInput = z.infer<typeof referenceDecisionSchema>;

export function validate(schema: z.ZodTypeAny, source: "body" | "params" | "query"): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) return next(parsed.error);
    if (source === "query") (req as unknown as { validatedQuery?: unknown }).validatedQuery = parsed.data;
    else req[source] = parsed.data;
    next();
  };
}

export function validatedQuery<T>(req: unknown): T {
  return (req as { validatedQuery?: T }).validatedQuery as T;
}
