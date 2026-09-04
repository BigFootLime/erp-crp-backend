// src/module/pieces-techniques/validators/versions.validators.ts
// GPAO B2.1 — validators des versions/indices d'une pièce technique.
import { z } from "zod"
import { uuidRouteParam } from "../../../utils/routeParams"

const uuid = z.string().uuid()

export const versionStatutSchema = z.enum(["BROUILLON", "EN_VALIDATION", "APPLICABLE", "OBSOLETE"])
export type VersionStatutDTO = z.infer<typeof versionStatutSchema>

const sqlDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD")
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`)
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    },
    "Date invalide"
  )

export const typeChangementSchema = z.enum(["EVOLUTION", "MODIFICATION"])
export type TypeChangementDTO = z.infer<typeof typeChangementSchema>

export const manufacturingModeSchema = z.enum(["SIMPLE", "ASSEMBLY"])
export type ManufacturingModeDTO = z.infer<typeof manufacturingModeSchema>

export const assemblySupplyStrategySchema = z.enum(["MAKE_TO_ORDER", "INTERNAL_CONTRACT"])
export type AssemblySupplyStrategyDTO = z.infer<typeof assemblySupplyStrategySchema>

export const versionIdParamSchema = z.object({
  params: z.object({ id: uuidRouteParam("id"), versionId: uuidRouteParam("versionId") }),
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
  manufacturing_mode: manufacturingModeSchema.optional(),
  assembly_supply_strategy: assemblySupplyStrategySchema.optional(),
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
    // Empêche qu'une valeur d'interface non SQL (ex. datetime ISO) atteigne le
    // cast `::date` de la transaction de publication et se transforme en 500.
    date_application: sqlDateSchema.optional().nullable(),
    commentaire_validation: z.string().max(2000).optional().nullable(),
    expected_updated_at: z.string().min(1).optional(),
  }),
})
export type VersionStatusBodyDTO = z.infer<typeof versionStatusSchema>["body"]

// Parcours guidé : le serveur passe lui-même BROUILLON → EN_VALIDATION →
// APPLICABLE dans une seule transaction. Les champs restent volontairement les
// mêmes que pour la transition unitaire afin que l'UI n'ait pas deux contrats.
export const publishVersionSchema = z.object({
  body: z.object({
    date_application: versionStatusSchema.shape.body.shape.date_application,
    // `undefined` = conserver la date configurée, `null` = rendre applicable
    // immédiatement. Ce champ est aussi autorisé sur une version déjà
    // Applicable pour corriger une date future qui bloquait les OF.
    date_effet: sqlDateSchema.optional().nullable(),
    commentaire_validation: z.string().max(2000).optional().nullable(),
    expected_updated_at: z.string().min(1).optional(),
  }),
})
export type PublishVersionBodyDTO = z.infer<typeof publishVersionSchema>["body"]

// "Nouvel indice / nouvelle évolution / nouvelle modification" (remplace le duplicate cassé).
export const createNextVersionSchema = z.object({ body: versionCoreBody })
export type CreateNextVersionBodyDTO = z.infer<typeof createNextVersionSchema>["body"]
