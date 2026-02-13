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

export const qualityControlTypeSchema = z.enum(["IN_PROCESS", "FINAL", "RECEPTION", "PERIODIC"]);
export type QualityControlTypeDTO = z.infer<typeof qualityControlTypeSchema>;

export const qualityControlStatusSchema = z.enum(["PLANNED", "IN_PROGRESS", "VALIDATED", "REJECTED"]);
export type QualityControlStatusDTO = z.infer<typeof qualityControlStatusSchema>;

export const qualityControlResultSchema = z.enum(["OK", "NOK", "PARTIAL"]);
export type QualityControlResultDTO = z.infer<typeof qualityControlResultSchema>;

export const qualityPointResultSchema = z.enum(["OK", "NOK"]);
export type QualityPointResultDTO = z.infer<typeof qualityPointResultSchema>;

export const nonConformitySeveritySchema = z.enum(["MINOR", "MAJOR", "CRITICAL"]);
export type NonConformitySeverityDTO = z.infer<typeof nonConformitySeveritySchema>;

export const nonConformityStatusSchema = z.enum(["OPEN", "ANALYSIS", "ACTION_PLAN", "CLOSED"]);
export type NonConformityStatusDTO = z.infer<typeof nonConformityStatusSchema>;

export const qualityActionTypeSchema = z.enum(["CORRECTIVE", "PREVENTIVE"]);
export type QualityActionTypeDTO = z.infer<typeof qualityActionTypeSchema>;

export const qualityActionStatusSchema = z.enum(["OPEN", "IN_PROGRESS", "DONE", "VERIFIED"]);
export type QualityActionStatusDTO = z.infer<typeof qualityActionStatusSchema>;

export const qualityEntityTypeSchema = z.enum(["CONTROL", "NON_CONFORMITY", "ACTION"]);
export type QualityEntityTypeDTO = z.infer<typeof qualityEntityTypeSchema>;

export const qualityDocumentTypeSchema = z.enum(["PV", "PHOTO", "CERTIFICATE", "REPORT", "OTHER"]);
export type QualityDocumentTypeDTO = z.infer<typeof qualityDocumentTypeSchema>;

export const controlIdParamSchema = z.object({
  params: z.object({ id: uuid }),
});

export const nonConformityIdParamSchema = z.object({
  params: z.object({ id: uuid }),
});

export const actionIdParamSchema = z.object({
  params: z.object({ id: uuid }),
});

export const controlPointInputSchema = z
  .object({
    characteristic: z.string().trim().min(1).max(300),
    nominal_value: z.coerce.number().finite().optional().nullable(),
    tolerance_min: z.coerce.number().finite().optional().nullable(),
    tolerance_max: z.coerce.number().finite().optional().nullable(),
    measured_value: z.coerce.number().finite().optional().nullable(),
    unit: z.string().trim().min(1).max(30).optional().nullable(),
    comment: z.string().trim().min(1).max(2000).optional().nullable(),
  })
  .strict();

export type ControlPointInputDTO = z.infer<typeof controlPointInputSchema>;

export const listControlsQuerySchema = z.object({
  q: z.string().optional(),
  status: qualityControlStatusSchema.optional(),
  control_type: qualityControlTypeSchema.optional(),
  result: qualityControlResultSchema.optional(),
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
  affaire_id: z.coerce.number().int().positive().optional(),
  of_id: z.coerce.number().int().positive().optional(),
  piece_technique_id: uuid.optional(),
  machine_id: uuid.optional(),
  poste_id: uuid.optional(),
  controlled_by: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortBy: z.enum(["control_date", "updated_at", "status"]).optional().default("control_date"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type ListControlsQueryDTO = z.infer<typeof listControlsQuerySchema>;

export const createControlSchema = z.object({
  body: z
    .object({
      affaire_id: z.coerce.number().int().positive().optional().nullable(),
      of_id: z.coerce.number().int().positive().optional().nullable(),
      piece_technique_id: uuid.optional().nullable(),
      operation_id: uuid.optional().nullable(),
      machine_id: uuid.optional().nullable(),
      poste_id: uuid.optional().nullable(),
      control_type: qualityControlTypeSchema,
      control_date: isoDateTime.optional(),
      comments: z.string().trim().min(1).max(5000).optional().nullable(),
      points: z.array(controlPointInputSchema).optional().default([]),
    })
    .strict(),
});

export type CreateControlBodyDTO = z.infer<typeof createControlSchema>["body"];

export const patchControlSchema = z.object({
  body: z.object({
    note: z.string().trim().min(1).max(2000).optional().nullable(),
    patch: z
      .object({
        affaire_id: z.coerce.number().int().positive().optional().nullable(),
        of_id: z.coerce.number().int().positive().optional().nullable(),
        piece_technique_id: uuid.optional().nullable(),
        operation_id: uuid.optional().nullable(),
        machine_id: uuid.optional().nullable(),
        poste_id: uuid.optional().nullable(),
        control_type: qualityControlTypeSchema.optional(),
        status: qualityControlStatusSchema.optional(),
        control_date: isoDateTime.optional(),
        comments: z.string().trim().min(1).max(5000).optional().nullable(),
        points: z.array(controlPointInputSchema).optional(),
      })
      .strict(),
  }),
});

export type PatchControlBodyDTO = z.infer<typeof patchControlSchema>["body"];

export const validateControlSchema = z.object({
  body: z.object({
    note: z.string().trim().min(1).max(2000).optional().nullable(),
  }),
});

export type ValidateControlBodyDTO = z.infer<typeof validateControlSchema>["body"];

export const kpisQuerySchema = z.object({
  today: isoDate.optional(),
});

export type KpisQueryDTO = z.infer<typeof kpisQuerySchema>;

export const listNonConformitiesQuerySchema = z.object({
  q: z.string().optional(),
  status: nonConformityStatusSchema.optional(),
  severity: nonConformitySeveritySchema.optional(),
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
  affaire_id: z.coerce.number().int().positive().optional(),
  of_id: z.coerce.number().int().positive().optional(),
  piece_technique_id: uuid.optional(),
  control_id: uuid.optional(),
  client_id: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortBy: z.enum(["detection_date", "updated_at", "severity"]).optional().default("detection_date"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type ListNonConformitiesQueryDTO = z.infer<typeof listNonConformitiesQuerySchema>;

export const createNonConformitySchema = z.object({
  body: z
    .object({
      reference: z.string().trim().min(1).max(80).optional(),
      affaire_id: z.coerce.number().int().positive().optional().nullable(),
      of_id: z.coerce.number().int().positive().optional().nullable(),
      piece_technique_id: uuid.optional().nullable(),
      control_id: uuid.optional().nullable(),
      client_id: z.string().trim().min(1).max(10).optional().nullable(),
      description: z.string().trim().min(1).max(10000),
      severity: nonConformitySeveritySchema.optional(),
      status: nonConformityStatusSchema.optional(),
      detection_date: isoDateTime.optional(),
      root_cause: z.string().trim().min(1).max(10000).optional().nullable(),
      impact: z.string().trim().min(1).max(10000).optional().nullable(),
    })
    .strict(),
});

export type CreateNonConformityBodyDTO = z.infer<typeof createNonConformitySchema>["body"];

export const patchNonConformitySchema = z.object({
  body: z.object({
    note: z.string().trim().min(1).max(2000).optional().nullable(),
    patch: z
      .object({
        reference: z.string().trim().min(1).max(80).optional(),
        affaire_id: z.coerce.number().int().positive().optional().nullable(),
        of_id: z.coerce.number().int().positive().optional().nullable(),
        piece_technique_id: uuid.optional().nullable(),
        control_id: uuid.optional().nullable(),
        client_id: z.string().trim().min(1).max(10).optional().nullable(),
        description: z.string().trim().min(1).max(10000).optional(),
        severity: nonConformitySeveritySchema.optional(),
        status: nonConformityStatusSchema.optional(),
        detection_date: isoDateTime.optional(),
        root_cause: z.string().trim().min(1).max(10000).optional().nullable(),
        impact: z.string().trim().min(1).max(10000).optional().nullable(),
      })
      .strict(),
  }),
});

export type PatchNonConformityBodyDTO = z.infer<typeof patchNonConformitySchema>["body"];

export const listActionsQuerySchema = z.object({
  q: z.string().optional(),
  status: qualityActionStatusSchema.optional(),
  action_type: qualityActionTypeSchema.optional(),
  responsible_user_id: z.coerce.number().int().positive().optional(),
  due_from: isoDate.optional(),
  due_to: isoDate.optional(),
  overdue: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === "true" ? true : v === "false" ? false : undefined)),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortBy: z.enum(["due_date", "updated_at", "status"]).optional().default("due_date"),
  sortDir: z.enum(["asc", "desc"]).optional().default("asc"),
});

export type ListActionsQueryDTO = z.infer<typeof listActionsQuerySchema>;

export const createActionSchema = z.object({
  body: z
    .object({
      non_conformity_id: uuid,
      action_type: qualityActionTypeSchema,
      description: z.string().trim().min(1).max(10000),
      responsible_user_id: z.coerce.number().int().positive(),
      due_date: isoDate.optional().nullable(),
      status: qualityActionStatusSchema.optional(),
      effectiveness_comment: z.string().trim().min(1).max(10000).optional().nullable(),
    })
    .strict(),
});

export type CreateActionBodyDTO = z.infer<typeof createActionSchema>["body"];

export const patchActionSchema = z.object({
  body: z.object({
    note: z.string().trim().min(1).max(2000).optional().nullable(),
    patch: z
      .object({
        action_type: qualityActionTypeSchema.optional(),
        description: z.string().trim().min(1).max(10000).optional(),
        responsible_user_id: z.coerce.number().int().positive().optional(),
        due_date: isoDate.optional().nullable(),
        status: qualityActionStatusSchema.optional(),
        verification_user_id: z.coerce.number().int().positive().optional().nullable(),
        verification_date: isoDateTime.optional().nullable(),
        effectiveness_comment: z.string().trim().min(1).max(10000).optional().nullable(),
      })
      .strict(),
  }),
});

export type PatchActionBodyDTO = z.infer<typeof patchActionSchema>["body"];

export const listUsersQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
});

export type ListUsersQueryDTO = z.infer<typeof listUsersQuerySchema>;

export const attachDocumentsSchema = z.object({
  body: z
    .object({
      document_type: qualityDocumentTypeSchema,
      label: z.string().trim().min(1).max(300).optional().nullable(),
    })
    .strict(),
});

export type AttachDocumentsBodyDTO = z.infer<typeof attachDocumentsSchema>["body"];

export const documentIdParamSchema = z.object({
  params: z.object({
    id: uuid,
    docId: uuid,
  }),
});
