// src/module/pieces-techniques/validators/pieces-techniques.validators.ts
import type { RequestHandler } from "express"
import { z } from "zod"

const uuid = z.string().uuid()

export const pieceTechniqueStatutSchema = z.enum([
  "DRAFT",
  "ACTIVE",
  "IN_FABRICATION",
  "OBSOLETE",
])

export type PieceTechniqueStatutDTO = z.infer<typeof pieceTechniqueStatutSchema>

export const idParamSchema = z.object({
  params: z.object({ id: uuid }),
})

export const bomLineIdParamSchema = z.object({
  params: z.object({ id: uuid, lineId: uuid }),
})

export const operationIdParamSchema = z.object({
  params: z.object({ id: uuid, opId: uuid }),
})

export const achatIdParamSchema = z.object({
  params: z.object({ id: uuid, achatId: uuid }),
})

export const documentIdParamSchema = z.object({
  params: z.object({ id: uuid, docId: uuid }),
})

export const affaireIdParamSchema = z.object({
  params: z.object({ id: uuid, affaireId: z.coerce.number().int().positive() }),
})

export const affaireOnlyParamSchema = z.object({
  params: z.object({ affaireId: z.coerce.number().int().positive() }),
})

export const affairePieceRoleSchema = z.enum(["MAIN", "LINKED"])

export const linkAffaireSchema = z.object({
  body: z.object({
    affaire_id: z.coerce.number().int().positive(),
    role: affairePieceRoleSchema.optional().default("LINKED"),
  }),
})

export type LinkAffaireBodyDTO = z.infer<typeof linkAffaireSchema>["body"]

export const listPiecesTechniquesQuerySchema = z.object({
  q: z.string().optional(),
  client_id: z.string().trim().min(1).max(3).optional(),
  famille_id: uuid.optional(),
  statut: pieceTechniqueStatutSchema.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z
    .enum(["updated_at", "created_at", "code_piece", "designation", "prix_unitaire", "statut"])
    .optional()
    .default("updated_at"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
})

export type ListPiecesTechniquesQueryDTO = z.infer<typeof listPiecesTechniquesQuerySchema>

export const getPieceTechniqueQuerySchema = z.object({
  include: z
    .preprocess((value) => {
      if (value === undefined || value === null) return "nomenclature,operations,achats,history"
      if (Array.isArray(value)) return value.join(",")
      if (typeof value === "string") return value
      return "nomenclature,operations,achats,history"
    }, z.string())
    .optional()
    .default("nomenclature,operations,achats,history"),
})

export type GetPieceTechniqueQueryDTO = z.infer<typeof getPieceTechniqueQuerySchema>

const bomLineInputSchema = z.object({
  child_piece_id: uuid,
  rang: z.coerce.number().int().min(1).optional(),
  quantite: z.coerce.number().positive().optional().default(1),
  repere: z.string().optional().nullable(),
  designation: z.string().optional().nullable(),
})

const operationInputSchema = z.object({
  phase: z.coerce.number().int().min(0).optional().default(10),
  designation: z.string().trim().min(1, "Désignation requise"),
  designation_2: z.string().optional().nullable(),
  cf_id: uuid.optional().nullable(),
  prix: z.coerce.number().min(0).optional().default(0),
  coef: z.coerce.number().min(0).optional().default(1),
  tp: z.coerce.number().min(0).optional().default(0),
  tf_unit: z.coerce.number().min(0).optional().default(0),
  qte: z.coerce.number().min(0).optional().default(1),
  taux_horaire: z.coerce.number().min(0).optional().default(0),
})

const achatInputSchema = z.object({
  phase: z.coerce.number().int().optional().nullable(),
  famille_piece_id: uuid.optional().nullable(),
  nom: z.string().optional().nullable(),
  article_id: uuid.optional().nullable(),
  fournisseur_id: uuid.optional().nullable(),
  fournisseur_nom: z.string().optional().nullable(),
  fournisseur_code: z.string().optional().nullable(),
  quantite: z.coerce.number().min(0).optional().default(1),
  quantite_brut_mm: z.coerce.number().optional().nullable(),
  longueur_mm: z.coerce.number().optional().nullable(),
  coefficient_chute: z.coerce.number().optional().nullable(),
  quantite_pieces: z.coerce.number().optional().nullable(),
  prix_par_quantite: z.coerce.number().optional().nullable(),
  tarif: z.coerce.number().optional().nullable(),
  prix: z.coerce.number().min(0).optional().nullable(),
  unite_prix: z.string().optional().nullable(),
  pu_achat: z.coerce.number().min(0).optional().nullable(),
  tva_achat: z.coerce.number().min(0).max(100).optional().default(20),
  designation: z.string().optional().nullable(),
  designation_2: z.string().optional().nullable(),
  designation_3: z.string().optional().nullable(),
})

export const createPieceTechniqueSchema = z.object({
  body: z.object({
    client_id: z.string().trim().min(1).max(3).optional().nullable(),
    code_client: z.string().trim().min(1).max(80).optional().nullable(),
    client_name: z.string().trim().min(1).max(200).optional().nullable(),
    famille_id: uuid,
    name_piece: z.string().trim().min(1, "Nom de pièce requis"),
    code_piece: z.string().trim().min(1, "Code pièce requis"),
    designation: z.string().trim().min(1, "Désignation requise"),
    designation_2: z.string().optional().nullable(),
    prix_unitaire: z.coerce.number().min(0).optional().default(0),
    statut: pieceTechniqueStatutSchema.optional().default("DRAFT"),
    cycle: z.coerce.number().int().optional().nullable(),
    cycle_fabrication: z.coerce.number().int().optional().nullable(),
    ensemble: z.boolean().optional().default(false),
    bom: z.array(bomLineInputSchema).optional().default([]),
    operations: z.array(operationInputSchema).optional().default([]),
    achats: z.array(achatInputSchema).optional().default([]),
  }),
})

export type CreatePieceTechniqueBodyDTO = z.infer<typeof createPieceTechniqueSchema>["body"]

export const updatePieceTechniqueSchema = z.object({
  body: z.object({
    expected_updated_at: z.string().min(1).optional(),
    client_id: z.string().trim().min(1).max(3).optional().nullable(),
    code_client: z.string().trim().min(1).max(80).optional().nullable(),
    client_name: z.string().trim().min(1).max(200).optional().nullable(),
    famille_id: uuid.optional(),
    name_piece: z.string().trim().min(1).optional(),
    code_piece: z.string().trim().min(1).optional(),
    designation: z.string().trim().min(1).optional(),
    designation_2: z.string().optional().nullable(),
    prix_unitaire: z.coerce.number().min(0).optional(),
    cycle: z.coerce.number().int().optional().nullable(),
    cycle_fabrication: z.coerce.number().int().optional().nullable(),
    ensemble: z.boolean().optional(),
    statut: pieceTechniqueStatutSchema.optional(),
    bom: z.array(bomLineInputSchema).optional(),
    operations: z.array(operationInputSchema).optional(),
    achats: z.array(achatInputSchema).optional(),
  }),
})

export type UpdatePieceTechniqueBodyDTO = z.infer<typeof updatePieceTechniqueSchema>["body"]

export const pieceTechniqueStatusSchema = z.object({
  body: z.object({
    expected_updated_at: z.string().min(1).optional(),
    next_statut: pieceTechniqueStatutSchema,
    commentaire: z.string().optional().nullable(),
  }),
})

export type PieceTechniqueStatusBodyDTO = z.infer<typeof pieceTechniqueStatusSchema>["body"]

export const addBomLineSchema = z.object({
  body: bomLineInputSchema,
})

export type AddBomLineBodyDTO = z.infer<typeof addBomLineSchema>["body"]

export const updateBomLineSchema = z.object({
  body: bomLineInputSchema.partial().extend({
    rang: z.coerce.number().int().min(1).optional(),
  }),
})

export type UpdateBomLineBodyDTO = z.infer<typeof updateBomLineSchema>["body"]

export const reorderSchema = z.object({
  body: z.object({
    order: z.array(uuid).min(1),
  }),
})

export type ReorderBodyDTO = z.infer<typeof reorderSchema>["body"]

export const addOperationSchema = z.object({
  body: operationInputSchema,
})

export type AddOperationBodyDTO = z.infer<typeof addOperationSchema>["body"]

export const updateOperationSchema = z.object({
  body: operationInputSchema.partial(),
})

export type UpdateOperationBodyDTO = z.infer<typeof updateOperationSchema>["body"]

export const addAchatSchema = z.object({
  body: achatInputSchema,
})

export type AddAchatBodyDTO = z.infer<typeof addAchatSchema>["body"]

export const updateAchatSchema = z.object({
  body: achatInputSchema.partial(),
})

export type UpdateAchatBodyDTO = z.infer<typeof updateAchatSchema>["body"]

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
