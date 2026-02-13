import { z } from "zod"
import type { BonLivraisonStatut } from "../types/livraisons.types"

export const bonLivraisonStatutSchema = z
  .enum(["DRAFT", "READY", "SHIPPED", "DELIVERED", "CANCELLED"]) satisfies z.ZodType<BonLivraisonStatut>

export const livraisonIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const livraisonLineIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  lineId: z.coerce.number().int().positive(),
})

export const livraisonDocParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  docId: z.string().uuid(),
})

export const fromCommandeParamsSchema = z.object({
  commandeId: z.coerce.number().int().positive(),
})

export const listLivraisonsQuerySchema = z
  .object({
    q: z.string().trim().min(1).optional(),
    client_id: z.string().trim().min(1).optional(),
    statut: bonLivraisonStatutSchema.optional(),
    from: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(200).optional(),
    sortBy: z.enum(["date_creation", "updated_at", "numero", "statut"]).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
  })
  .passthrough()

export type ListLivraisonsQueryDTO = z.infer<typeof listLivraisonsQuerySchema>

export const createLivraisonBodySchema = z
  .object({
    client_id: z.string().trim().min(1),
    commande_id: z.coerce.number().int().positive().optional().nullable(),
    affaire_id: z.coerce.number().int().positive().optional().nullable(),
    adresse_livraison_id: z.string().uuid().optional().nullable(),
    date_creation: z.string().trim().min(1).optional(),
    commentaire_interne: z.string().optional().nullable(),
    commentaire_client: z.string().optional().nullable(),
    transporteur: z.string().optional().nullable(),
    tracking_number: z.string().optional().nullable(),
    lignes: z
      .array(
        z.object({
          ordre: z.coerce.number().int().positive().optional(),
          designation: z.string().trim().min(1).max(10000),
          code_piece: z.string().trim().min(1).max(200).optional().nullable(),
          quantite: z.coerce.number().positive(),
          unite: z.string().trim().min(1).max(30).optional().nullable(),
          commande_ligne_id: z.coerce.number().int().positive().optional().nullable(),
          delai_client: z.string().trim().min(1).max(100).optional().nullable(),
        })
      )
      .optional(),
  })
  .passthrough()

export type CreateLivraisonBodyDTO = z.infer<typeof createLivraisonBodySchema>

export const updateLivraisonBodySchema = z
  .object({
    commande_id: z.coerce.number().int().positive().optional().nullable(),
    affaire_id: z.coerce.number().int().positive().optional().nullable(),
    adresse_livraison_id: z.string().uuid().optional().nullable(),
    date_creation: z.string().trim().min(1).optional(),
    date_expedition: z.string().trim().min(1).optional().nullable(),
    date_livraison: z.string().trim().min(1).optional().nullable(),
    transporteur: z.string().optional().nullable(),
    tracking_number: z.string().optional().nullable(),
    commentaire_interne: z.string().optional().nullable(),
    commentaire_client: z.string().optional().nullable(),
    reception_nom_signataire: z.string().optional().nullable(),
    reception_date_signature: z.string().trim().min(1).optional().nullable(),
  })
  .passthrough()

export type UpdateLivraisonBodyDTO = z.infer<typeof updateLivraisonBodySchema>

export const createLivraisonLineBodySchema = z
  .object({
    ordre: z.coerce.number().int().positive().optional(),
    designation: z.string().trim().min(1).max(10000),
    code_piece: z.string().trim().min(1).max(200).optional().nullable(),
    quantite: z.coerce.number().positive(),
    unite: z.string().trim().min(1).max(30).optional().nullable(),
    commande_ligne_id: z.coerce.number().int().positive().optional().nullable(),
    delai_client: z.string().trim().min(1).max(100).optional().nullable(),
  })
  .passthrough()

export type CreateLivraisonLineBodyDTO = z.infer<typeof createLivraisonLineBodySchema>

export const updateLivraisonLineBodySchema = z
  .object({
    ordre: z.coerce.number().int().positive().optional(),
    designation: z.string().trim().min(1).max(10000).optional(),
    code_piece: z.string().trim().min(1).max(200).optional().nullable(),
    quantite: z.coerce.number().positive().optional(),
    unite: z.string().trim().min(1).max(30).optional().nullable(),
    commande_ligne_id: z.coerce.number().int().positive().optional().nullable(),
    delai_client: z.string().trim().min(1).max(100).optional().nullable(),
  })
  .passthrough()

export type UpdateLivraisonLineBodyDTO = z.infer<typeof updateLivraisonLineBodySchema>

export const livraisonStatusBodySchema = z
  .object({
    statut: bonLivraisonStatutSchema,
    commentaire: z.string().trim().min(1).max(5000).optional().nullable(),
  })
  .passthrough()

export type LivraisonStatusBodyDTO = z.infer<typeof livraisonStatusBodySchema>
