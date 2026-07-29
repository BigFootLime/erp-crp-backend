import { z } from "zod";

import { GED_VERSION_STATUSES } from "../domain/ged-policy";

const trimmed = (min: number, max: number) =>
  z.string().transform((v) => v.trim()).pipe(z.string().min(min).max(max));

export const GED_LINK_ENTITY_TYPES = ["PIECE_TECHNIQUE_VERSION"] as const;

const accessScopeFields = {
  entity_type: z.enum(GED_LINK_ENTITY_TYPES).optional().nullable(),
  entity_id: z.string().uuid("Identifiant de parent invalide.").optional().nullable(),
};

function requireCompleteScope(
  value: { entity_type?: string | null; entity_id?: string | null },
  ctx: z.RefinementCtx
) {
  if (Boolean(value.entity_type) !== Boolean(value.entity_id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Le type et l'identifiant du parent doivent être fournis ensemble.",
      path: value.entity_type ? ["entity_id"] : ["entity_type"],
    });
  }
}

export const uploadDocumentBodySchema = z
  .object({
    class_key: trimmed(1, 64),
    title: trimmed(2, 200),
    description: z.string().trim().max(2000).optional().nullable(),
    change_reason: z.string().trim().max(500).optional().nullable(),
    ...accessScopeFields,
    link_role: z.string().trim().max(64).optional().nullable(),
  })
  .superRefine(requireCompleteScope);

export type UploadDocumentBody = z.infer<typeof uploadDocumentBodySchema>;

export const newVersionBodySchema = z
  .object({
    change_reason: trimmed(3, 500),
    ...accessScopeFields,
  })
  .superRefine(requireCompleteScope);

export const transitionBodySchema = z
  .object({
    comment: z.string().trim().max(1000).optional().nullable(),
    ...accessScopeFields,
  })
  .superRefine(requireCompleteScope);

export const listQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional().nullable(),
    class_key: z.string().trim().max(64).optional().nullable(),
    domain: z.string().trim().max(64).optional().nullable(),
    status: z.enum(GED_VERSION_STATUSES).optional().nullable(),
    ...accessScopeFields,
    include_archived: z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((v) => v === true || v === "true" || v === "1"),
    page: z.coerce.number().int().min(1).max(10000).optional().default(1),
    page_size: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .superRefine(requireCompleteScope);

export const accessScopeQuerySchema = z
  .object(accessScopeFields)
  .superRefine(requireCompleteScope);

export const uuidParamSchema = z.string().uuid("Identifiant invalide.");
