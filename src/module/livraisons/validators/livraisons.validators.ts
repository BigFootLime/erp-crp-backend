import { z } from "zod"
import type { BonLivraisonStatut } from "../types/livraisons.types"

const uuid = z.string().uuid()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ")
const nullableText = (max: number) => z.string().trim().min(1).max(max).optional().nullable()

export const bonLivraisonStatutSchema = z
  .enum(["DRAFT", "READY", "SHIPPED", "DELIVERED", "CANCELLED"]) satisfies z.ZodType<BonLivraisonStatut>

export const livraisonIdParamsSchema = z.object({
  id: uuid,
}).strict()

export const livraisonLineIdParamsSchema = z.object({
  id: uuid,
  lineId: uuid,
}).strict()

export const livraisonLineAllocationIdParamsSchema = z.object({
  id: uuid,
  lineId: uuid,
  allocationId: uuid,
}).strict()

export const livraisonDocParamsSchema = z.object({
  id: uuid,
  docId: uuid,
}).strict()

export const fromCommandeParamsSchema = z.object({
  commandeId: z.coerce.number().int().positive(),
}).strict()

export const listLivraisonsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(120).optional(),
    client_id: z.string().trim().min(1).optional(),
    statut: bonLivraisonStatutSchema.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(200).optional(),
    sortBy: z.enum(["date_creation", "updated_at", "numero", "statut"]).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
  })
  .strict()

export type ListLivraisonsQueryDTO = z.infer<typeof listLivraisonsQuerySchema>

export const createLivraisonBodySchema = z
  .object({
    client_id: z.string().trim().min(1),
    commande_id: z.coerce.number().int().positive().optional().nullable(),
    affaire_id: z.coerce.number().int().positive().optional().nullable(),
    adresse_livraison_id: uuid.optional().nullable(),
    date_creation: isoDate.optional(),
    commentaire_interne: nullableText(5000),
    commentaire_client: nullableText(2000),
    transporteur: nullableText(200),
    tracking_number: nullableText(200),
    lignes: z
      .array(
        z
          .object({
            ordre: z.coerce.number().int().positive().optional(),
            designation: z.string().trim().min(1).max(10000),
            code_piece: nullableText(200),
            quantite: z.coerce.number().positive().max(1_000_000_000),
            unite: nullableText(30),
            commande_ligne_id: z.coerce.number().int().positive().optional().nullable(),
            delai_client: isoDate.optional().nullable(),
          })
          .strict()
      )
      .max(500)
      .optional(),
  })
  .strict()

export type CreateLivraisonBodyDTO = z.infer<typeof createLivraisonBodySchema>

export const updateLivraisonBodySchema = z
  .object({
    commande_id: z.coerce.number().int().positive().optional().nullable(),
    affaire_id: z.coerce.number().int().positive().optional().nullable(),
    adresse_livraison_id: uuid.optional().nullable(),
    date_creation: isoDate.optional(),
    date_expedition: isoDate.optional().nullable(),
    date_livraison: isoDate.optional().nullable(),
    transporteur: nullableText(200),
    tracking_number: nullableText(200),
    commentaire_interne: nullableText(5000),
    commentaire_client: nullableText(2000),
    reception_nom_signataire: nullableText(200),
    reception_date_signature: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .strict()

export type UpdateLivraisonBodyDTO = z.infer<typeof updateLivraisonBodySchema>

export const createLivraisonLineBodySchema = z
  .object({
    ordre: z.coerce.number().int().positive().optional(),
    designation: z.string().trim().min(1).max(10000),
    code_piece: nullableText(200),
    quantite: z.coerce.number().positive().max(1_000_000_000),
    unite: nullableText(30),
    commande_ligne_id: z.coerce.number().int().positive().optional().nullable(),
    delai_client: isoDate.optional().nullable(),
  })
  .strict()

export type CreateLivraisonLineBodyDTO = z.infer<typeof createLivraisonLineBodySchema>

export const updateLivraisonLineBodySchema = z
  .object({
    ordre: z.coerce.number().int().positive().optional(),
    designation: z.string().trim().min(1).max(10000).optional(),
    code_piece: nullableText(200),
    quantite: z.coerce.number().positive().max(1_000_000_000).optional(),
    unite: nullableText(30),
    commande_ligne_id: z.coerce.number().int().positive().optional().nullable(),
    delai_client: isoDate.optional().nullable(),
  })
  .strict()

export type UpdateLivraisonLineBodyDTO = z.infer<typeof updateLivraisonLineBodySchema>

export const livraisonStatusBodySchema = z
  .object({
    statut: bonLivraisonStatutSchema,
    commentaire: z.string().trim().min(1).max(5000).optional().nullable(),
  })
  .strict()

export type LivraisonStatusBodyDTO = z.infer<typeof livraisonStatusBodySchema>

export const createLivraisonAllocationBodySchema = z
  .object({
    article_id: uuid,
    magasin_id: uuid,
    emplacement_id: z.coerce.number().int().positive(),
    lot_id: uuid.optional().nullable(),
    quantite: z.coerce.number().positive().max(1_000_000_000),
    unite: nullableText(30),
  })
  .strict()

export type CreateLivraisonAllocationBodyDTO = z.infer<typeof createLivraisonAllocationBodySchema>

export const shipLivraisonBodySchema = z
  .object({
    expected_version: z.coerce.number().int().positive(),
    preview_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    commentaire: nullableText(2000),
  })
  .strict()

export type ShipLivraisonBodyDTO = z.infer<typeof shipLivraisonBodySchema>

export const livraisonProofBodySchema = z
  .object({
    proof_type: z.enum(["RECIPIENT_ACK", "CARRIER_DOCUMENT", "PHOTO", "EXTERNAL_SIGNATURE"]),
    delivered_at: z.string().datetime({ offset: true }),
    received_by_name: nullableText(200),
    document_id: uuid.optional().nullable(),
    note: nullableText(2000),
  })
  .strict()

export type LivraisonProofBodyDTO = z.infer<typeof livraisonProofBodySchema>
