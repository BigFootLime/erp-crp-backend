import { z } from "zod";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date (expected YYYY-MM-DD)");

function isParsableDateTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

const isoDateTime = z
  .string()
  .trim()
  .min(1)
  .refine((v) => isParsableDateTime(v), "Invalid date-time");

export const pointageIdParamSchema = z.object({
  params: z.object({ id: uuid }),
});

export const pointageTimeTypeSchema = z.enum(["OPERATEUR", "MACHINE", "PROGRAMMATION"]);
export type PointageTimeTypeDTO = z.infer<typeof pointageTimeTypeSchema>;

export const pointageStatusSchema = z.enum(["RUNNING", "DONE", "CANCELLED", "CORRECTED"]);
export type PointageStatusDTO = z.infer<typeof pointageStatusSchema>;

export const listPointagesQuerySchema = z.object({
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
  of_id: z.coerce.number().int().positive().optional(),
  machine_id: uuid.optional(),
  poste_id: uuid.optional(),
  operator_user_id: z.coerce.number().int().positive().optional(),
  time_type: pointageTimeTypeSchema.optional(),
  status: pointageStatusSchema.optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortBy: z.enum(["start_ts", "end_ts", "duration_minutes", "updated_at"]).optional().default("start_ts"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type ListPointagesQueryDTO = z.infer<typeof listPointagesQuerySchema>;

export const createPointageManualSchema = z.object({
  body: z.object({
    of_id: z.coerce.number().int().positive(),
    operation_id: uuid.optional().nullable(),
    affaire_id: z.coerce.number().int().positive().optional().nullable(),
    piece_technique_id: uuid.optional().nullable(),
    machine_id: uuid.optional().nullable(),
    poste_id: uuid.optional().nullable(),
    operator_user_id: z.coerce.number().int().positive(),
    time_type: pointageTimeTypeSchema,
    start_ts: isoDateTime,
    end_ts: isoDateTime,
    comment: z.string().trim().min(1).optional().nullable(),
  }),
});

export type CreatePointageManualBodyDTO = z.infer<typeof createPointageManualSchema>["body"];

export const startPointageSchema = z.object({
  body: z.object({
    of_id: z.coerce.number().int().positive(),
    operation_id: uuid.optional().nullable(),
    machine_id: uuid.optional().nullable(),
    poste_id: uuid.optional().nullable(),
    operator_user_id: z.coerce.number().int().positive(),
    time_type: pointageTimeTypeSchema,
    comment: z.string().trim().min(1).optional().nullable(),
  }),
});

export type StartPointageBodyDTO = z.infer<typeof startPointageSchema>["body"];

export const stopPointageSchema = z.object({
  body: z.object({
    comment: z.string().trim().min(1).optional().nullable(),
  }),
});

export type StopPointageBodyDTO = z.infer<typeof stopPointageSchema>["body"];

export const patchPointageSchema = z.object({
  body: z.object({
    correction_reason: z.string().trim().min(3).max(500),
    patch: z
      .object({
        of_id: z.coerce.number().int().positive().optional(),
        operation_id: uuid.optional().nullable(),
        affaire_id: z.coerce.number().int().positive().optional().nullable(),
        piece_technique_id: uuid.optional().nullable(),
        machine_id: uuid.optional().nullable(),
        poste_id: uuid.optional().nullable(),
        operator_user_id: z.coerce.number().int().positive().optional(),
        time_type: pointageTimeTypeSchema.optional(),
        start_ts: isoDateTime.optional(),
        end_ts: isoDateTime.optional().nullable(),
        comment: z.string().trim().min(1).optional().nullable(),
        status: z.enum(["CANCELLED"]).optional(),
      })
      .strict(),
  }),
});

export type PatchPointageBodyDTO = z.infer<typeof patchPointageSchema>["body"];

export const validatePointageSchema = z.object({
  body: z.object({
    note: z.string().trim().min(1).optional().nullable(),
  }),
});

export type ValidatePointageBodyDTO = z.infer<typeof validatePointageSchema>["body"];

export const pointagesKpisQuerySchema = z.object({
  date_from: isoDate,
  date_to: isoDate,
});

export type PointagesKpisQueryDTO = z.infer<typeof pointagesKpisQuerySchema>;

export const listOperatorsQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
});

export type ListOperatorsQueryDTO = z.infer<typeof listOperatorsQuerySchema>;
