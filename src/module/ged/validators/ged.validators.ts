// GED centrale CERP (ADR-0037) — validation d'entrée.

import { z } from "zod";

import { GED_VERSION_STATUSES } from "../domain/ged-policy";

const trimmed = (min: number, max: number) =>
  z.string().transform((v) => v.trim()).pipe(z.string().min(min).max(max));

export const uploadDocumentBodySchema = z.object({
  class_key: trimmed(1, 64),
  title: trimmed(2, 200),
  description: z.string().trim().max(2000).optional().nullable(),
  change_reason: z.string().trim().max(500).optional().nullable(),
  entity_type: z.string().trim().max(64).optional().nullable(),
  entity_id: z.string().trim().max(128).optional().nullable(),
  link_role: z.string().trim().max(64).optional().nullable(),
}).superRefine((value, context) => {
  const hasType = Boolean(value.entity_type);
  const hasId = Boolean(value.entity_id);
  if (hasType !== hasId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: hasType ? ["entity_id"] : ["entity_type"],
      message: "Le type et l’identifiant de l’entité doivent être fournis ensemble.",
    });
  }
  if (value.link_role && (!hasType || !hasId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["link_role"],
      message: "Le rôle du lien exige une entité cible.",
    });
  }
});

export type UploadDocumentBody = z.infer<typeof uploadDocumentBodySchema>;

export const newVersionBodySchema = z.object({
  // Une nouvelle version exige un motif : « pourquoi » fait partie du document.
  change_reason: trimmed(3, 500),
});

export const transitionBodySchema = z.object({
  comment: z.string().trim().max(1000).optional().nullable(),
});

export const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional().nullable(),
  class_key: z.string().trim().max(64).optional().nullable(),
  domain: z.string().trim().max(64).optional().nullable(),
  status: z.enum(GED_VERSION_STATUSES).optional().nullable(),
  entity_type: z.string().trim().max(64).optional().nullable(),
  entity_id: z.string().trim().max(128).optional().nullable(),
  link_role: z.string().trim().max(64).optional().nullable(),
  include_archived: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === "true" || v === "1"),
  page: z.coerce.number().int().min(1).max(10000).optional().default(1),
  page_size: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export const uuidParamSchema = z.string().uuid("Identifiant invalide.");
