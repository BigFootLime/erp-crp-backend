// src/module/pieces-techniques/validators/versions.validators.ts
// GPAO B2.1 — validators des versions/indices d'une pièce technique.
import { z } from "zod"

const uuid = z.string().uuid()

export const versionStatutSchema = z.enum(["BROUILLON", "EN_VALIDATION", "APPLICABLE", "OBSOLETE"])
export type VersionStatutDTO = z.infer<typeof versionStatutSchema>

export const typeChangementSchema = z.enum(["EVOLUTION", "MODIFICATION"])
export type TypeChangementDTO = z.infer<typeof typeChangementSchema>

export const versionIdParamSchema = z.object({
  params: z.object({ id: uuid, versionId: uuid }),
})

const versionCoreBody = z.object({
  indice: z.string().trim().min(1, "Indice requis").max(20),
  plan_reference: z.string().trim().max(160).optional().nullable(),
  matiere_prevue: z.string().trim().max(200).optional().nullable(),
  commentaire_revision: z.string().max(2000).optional().nullable(),
  type_changement: typeChangementSchema.optional().nullable(),
  raison_changement: z.string().max(2000).optional().nullable(),
  impact_interchangeabilite: z.boolean().optional().nullable(),
  impact_parents: z.string().max(2000).optional().nullable(),
  date_effet: z.string().date().optional().nullable(),
})

export const createVersionSchema = z.object({ body: versionCoreBody })
export type CreateVersionBodyDTO = z.infer<typeof createVersionSchema>["body"]

export const updateVersionSchema = z.object({
  body: versionCoreBody.partial().extend({
    expected_updated_at: z.string().min(1).optional(),
  }),
})
export type UpdateVersionBodyDTO = z.infer<typeof updateVersionSchema>["body"]

export const versionStatusSchema = z.object({
  body: z.object({
    next_statut: versionStatutSchema,
    date_application: z.string().min(1).optional().nullable(),
    commentaire_validation: z.string().max(2000).optional().nullable(),
    expected_updated_at: z.string().min(1).optional(),
  }),
})
export type VersionStatusBodyDTO = z.infer<typeof versionStatusSchema>["body"]

// "Nouvel indice / nouvelle évolution / nouvelle modification" (remplace le duplicate cassé).
export const createNextVersionSchema = z.object({ body: versionCoreBody })
export type CreateNextVersionBodyDTO = z.infer<typeof createNextVersionSchema>["body"]
