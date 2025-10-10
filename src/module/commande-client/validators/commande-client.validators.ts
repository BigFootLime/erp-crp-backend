import { z } from "zod"

const pieceSchema = z.object({
  id: z.string().uuid(),
  source_piece_id: z.string().uuid().optional().nullable(),
  code_piece: z.string().optional().nullable(),
  designation: z.string().min(1),
  rang: z.number().int().min(1),
  parent_id: z.string().uuid().optional().nullable(),
  plan: z.string().optional().nullable(),
  coef: z.number().min(0),
  article_id: z.string().optional().nullable(),
})

const operationSchema = z.object({
  piece_id: z.string().uuid(),
  phase: z.number().int().min(0),
  designation: z.string().min(1),
  poste_id: z.string().optional().nullable(),
  coef: z.number().min(0),
  tp: z.number().min(0),
  tf_unit: z.number().min(0),
  qte: z.number().min(0),
  taux_horaire: z.number().min(0),
  temps_total: z.number().min(0),
  cout_mo: z.number().min(0),
})

const achatSchema = z.object({
  piece_id: z.string().uuid(),
  article_id: z.string().optional().nullable(),
  designation: z.string().min(1),
  fournisseur_id: z.string().optional().nullable(),
  qte: z.number().positive(),
  unite: z.string().optional().nullable(),
  pu_achat: z.number().min(0),
  tva_achat: z.number().min(0).max(100),
  total_achat_ht: z.number().min(0),
  total_achat_ttc: z.number().min(0),
})

const ligneSchema = z.object({
  designation: z.string().min(1),
  code_piece: z.string().optional().nullable(),
  quantite: z.number().positive(),
  unite: z.string().optional().nullable().default("u"),
  prix_unitaire_ht: z.number().min(0),
  remise_ligne: z.number().min(0).max(100).default(0),
  taux_tva: z.number().min(0).max(100).default(20),
  delai_client: z.string().optional().nullable(),
  delai_interne: z.string().optional().nullable(),
  total_ht: z.number().min(0),
  total_ttc: z.number().min(0),
  devis_numero: z.string().optional().nullable(),
  famille: z.string().optional().nullable(),
})

const echeanceSchema = z.object({
  libelle: z.string().min(1),
  date_echeance: z.string().min(1),
  pourcentage: z.number().min(0).max(100),
  montant: z.number().min(0),
})

export const createCommandeBodySchema = z.object({
  numero: z.string().min(1),
  designation: z.string().optional().nullable(),
  client_id: z.string().min(1),
  contact_id: z.string().optional().nullable(),
  destinataire_id: z.string().optional().nullable(),
  emetteur: z.string().optional().nullable(),
  code_client: z.string().optional().nullable(),
  date_commande: z.string().min(1),
  arc_edi: z.boolean().default(false),
  arc_date_envoi: z.string().optional().nullable(),
  compteur_affaire_id: z.string().optional().nullable(),
  type_affaire: z.enum(["fabrication","previsionnel","regroupement"]).default("fabrication"),
  mode_port_id: z.string().optional().nullable(),
  mode_reglement_id: z.string().optional().nullable(),
  commentaire: z.string().optional().nullable(),
  remise_globale: z.number().min(0).max(100).default(0),
  total_ht: z.number().min(0).default(0),
  total_ttc: z.number().min(0).default(0),
  lignes: z.array(ligneSchema).min(1),
  echeancier: z.array(echeanceSchema).default([]),
  pieces: z.array(pieceSchema).min(1),
  operations: z.array(operationSchema).default([]),
  achats: z.array(achatSchema).default([]),
})

export const idParamSchema = z.object({
  params: z.object({ id: z.string().uuid("id must be a uuid") }),
})

// middleware réutilisable
export function validate(schema: z.ZodTypeAny) {
  return (req: any, res: any, next: any) => {
    const parsed = schema.safeParse({ body: req.body, params: req.params, query: req.query })
    if (!parsed.success) {
      const msg = parsed.error.issues?.[0]?.message ?? "Invalid request"
      return res.status(400).json({ error: msg })
    }
    next()
  }
}
