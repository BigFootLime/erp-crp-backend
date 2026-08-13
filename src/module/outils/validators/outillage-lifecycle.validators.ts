import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const uuid = z.string().uuid();
const reason = z.string().trim().min(3).max(500);
const notes = z.string().trim().max(2_000).nullish().transform((value) => value || null);

export const allocationIdParamsSchema = z.object({ allocationId: uuid });
export const toolIdParamsSchema = z.object({ id: positiveInteger });
export const technicalVersionParamsSchema = z.object({ id: uuid, versionId: uuid });

export const reserveToolSchema = z.object({
  id_outil: positiveInteger,
  piece_technique_id: uuid,
  piece_technique_version_id: uuid,
  of_id: positiveInteger.nullish().transform((value) => value ?? null),
  quantity: positiveInteger,
  reason,
  notes,
});

export const lifecycleTransitionSchema = z.object({ quantity: positiveInteger, reason, notes });

export const listAllocationsSchema = z.object({
  id_outil: positiveInteger.optional(),
  piece_technique_version_id: uuid.optional(),
  of_id: positiveInteger.optional(),
  open_only: z.enum(["true", "false"]).optional().transform((value) => value !== "false"),
});

export const replaceToolRequirementsSchema = z.object({
  requirements: z.array(z.object({
    id_outil: positiveInteger,
    required_quantity: positiveInteger,
    usage_notes: z.string().trim().max(2_000).nullish().transform((value) => value || null),
  })).max(250).superRefine((items, ctx) => {
    const seen = new Set<number>();
    items.forEach((item, index) => {
      if (seen.has(item.id_outil)) ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "id_outil"],
        message: "Un outil ne peut apparaître qu'une fois",
      });
      seen.add(item.id_outil);
    });
  }),
  reason,
});

export const createToolParameterVersionSchema = z.object({
  effective_from: z.string().datetime({ offset: true }),
  unit_cost: z.coerce.number().nonnegative().nullable(),
  expected_life_pieces: z.coerce.number().positive().nullable(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default("EUR"),
  source: z.string().trim().min(3).max(500),
  source_observed_at: z.string().datetime({ offset: true }),
  reliability: z.enum(["DECLARED", "MEASURED", "VERIFIED"]),
  change_reason: reason,
}).refine((value) => value.unit_cost !== null || value.expected_life_pieces !== null, {
  message: "Un coût ou une durée de vie doit être renseigné",
});

export type ReserveToolInput = z.infer<typeof reserveToolSchema>;
export type LifecycleTransitionInput = z.infer<typeof lifecycleTransitionSchema>;
export type ReplaceToolRequirementsInput = z.infer<typeof replaceToolRequirementsSchema>;
export type CreateToolParameterVersionInput = z.infer<typeof createToolParameterVersionSchema>;
