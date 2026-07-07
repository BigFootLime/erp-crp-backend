// src/module/gammes/validators/gammes.validators.ts
// GPAO B2.2 — validators des gammes + opérations de gamme.
import type { RequestHandler } from "express"
import { z } from "zod"

const uuid = z.string().uuid()

export const gammeStatutSchema = z.enum(["BROUILLON", "EN_VALIDATION", "APPLICABLE", "OBSOLETE"])
export type GammeStatutDTO = z.infer<typeof gammeStatutSchema>

export const operationTypeSchema = z.enum([
  "TOURNAGE",
  "FRAISAGE",
  "REPRISE",
  "CONTROLE",
  "LAVAGE",
  "SOUS_TRAITANCE",
  "EMBALLAGE",
  "AUTRE",
])
export type OperationTypeDTO = z.infer<typeof operationTypeSchema>

export const versionIdParamSchema = z.object({ params: z.object({ versionId: uuid }) })
export const gammeIdParamSchema = z.object({ params: z.object({ gammeId: uuid }) })

const gammeCore = z.object({
  nom: z.string().trim().min(1, "Nom de gamme requis").max(200),
  code: z.string().trim().max(80).optional().nullable(),
  designation: z.string().trim().max(200).optional().nullable(),
  commentaire: z.string().max(2000).optional().nullable(),
  statut: gammeStatutSchema.optional().default("BROUILLON"),
  is_current: z.boolean().optional().default(false),
})

export const createGammeSchema = z.object({ body: gammeCore })
export type CreateGammeBodyDTO = z.infer<typeof createGammeSchema>["body"]

export const updateGammeSchema = z.object({
  body: gammeCore.partial().extend({ expected_updated_at: z.string().min(1).optional() }),
})
export type UpdateGammeBodyDTO = z.infer<typeof updateGammeSchema>["body"]

// Opération de gamme. Noms métier mappés aux colonnes DB : numero_operation→phase,
// temps_preparation→tp, temps_cycle→tf_unit.
const operationCore = z.object({
  numero_operation: z.coerce.number().int().min(0).optional().default(10),
  designation: z.string().trim().min(1, "Désignation requise"),
  designation_2: z.string().optional().nullable(),
  type_operation: operationTypeSchema.optional().nullable(),
  machine_id: uuid.optional().nullable(),
  poste_id: uuid.optional().nullable(),
  cf_id: uuid.optional().nullable(),
  temps_preparation: z.coerce.number().min(0).optional().default(0),
  temps_cycle: z.coerce.number().min(0).optional().default(0),
  qte: z.coerce.number().min(0).optional().default(1),
  coef: z.coerce.number().min(0).optional().default(1),
  taux_horaire: z.coerce.number().min(0).optional().default(0),
  prix: z.coerce.number().min(0).optional().default(0),
  consignes: z.string().max(4000).optional().nullable(),
})

export const addGammeOperationSchema = z.object({ body: operationCore })
export type AddGammeOperationBodyDTO = z.infer<typeof addGammeOperationSchema>["body"]

export const reorderOperationsSchema = z.object({ body: z.object({ order: z.array(uuid).min(1) }) })
export type ReorderOperationsBodyDTO = z.infer<typeof reorderOperationsSchema>["body"]

export function validate(schema: z.ZodTypeAny): RequestHandler {
  return (req, _res, next) => {
    try {
      schema.parse({ body: req.body, params: req.params, query: req.query })
      next()
    } catch (e) {
      next(e)
    }
  }
}
