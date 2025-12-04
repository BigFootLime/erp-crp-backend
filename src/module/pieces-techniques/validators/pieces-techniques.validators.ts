// src/module/pieces-techniques/validators/pieces-techniques.validators.ts
import { z } from "zod"

const bomLineSchema = z.object({
  id: z.string().uuid().optional(),
  child_piece_technique_id: z.string().uuid({ message: "Sous-pièce requise" }),
  rang: z.number().int().min(1, "Rang >= 1"),
  quantite: z.number().nonnegative(),
  repere: z.string().optional().nullable(),
  designation: z.string().optional().nullable(),
})

const operationSchema = z.object({
  id: z.string().uuid().optional(),
  phase: z.number().int().min(0).default(10),
  designation: z.string().min(1, "Désignation requise"),
  designation_2: z.string().optional().nullable(),
  cf_id: z.string().uuid().optional().nullable(),
  prix: z.number().nonnegative().default(0),
  coef: z.number().nonnegative().default(1),
  tp: z.number().nonnegative().default(0),
  tf_unit: z.number().nonnegative().default(0),
  qte: z.number().nonnegative().default(1),
  taux_horaire: z.number().nonnegative().default(0),
  temps_total: z.number().nonnegative().default(0),
  cout_mo: z.number().nonnegative().default(0),
})

const achatSchema = z.object({
  id: z.string().uuid().optional(),
  phase: z.number().int().optional().nullable(),
  famille_piece_id: z.string().uuid().optional().nullable(),
  nom: z.string().optional().nullable(),
  fournisseur_id: z.string().uuid().optional().nullable(),
  fournisseur_nom: z.string().optional().nullable(),
  fournisseur_code: z.string().optional().nullable(),
  quantite: z.number().nonnegative().default(1),
  quantite_brut_mm: z.number().optional().nullable(),
  longueur_mm: z.number().optional().nullable(),
  coefficient_chute: z.number().optional().nullable(),
  quantite_pieces: z.number().optional().nullable(),
  prix_par_quantite: z.number().optional().nullable(),
  tarif: z.number().optional().nullable(),
  prix: z.number().optional().nullable(),
  unite_prix: z.string().optional().nullable(),
  pu_achat: z.number().optional().nullable(),
  tva_achat: z.number().optional().nullable(),
  total_achat_ht: z.number().optional().nullable(),
  total_achat_ttc: z.number().optional().nullable(),
  designation: z.string().optional().nullable(),
  designation_2: z.string().optional().nullable(),
  designation_3: z.string().optional().nullable(),
})

export const createPieceTechniqueSchema = z.object({
  body: z.object({
    client_id: z.string().max(3).optional().nullable(),
    created_by: z.number().int().optional().nullable(),
    updated_by: z.number().int().optional().nullable(),

    famille_id: z.string().uuid({ message: "Famille requise" }),
    name_piece: z.string().min(1, "Nom de pièce requis"),
    code_piece: z.string().min(1, "Code pièce requis"),
    designation: z.string().min(1, "Désignation requise"),
    designation_2: z.string().optional().nullable(),
    prix_unitaire: z.number().nonnegative(),
    en_fabrication: z.boolean().default(false),
    cycle: z.number().int().optional().nullable(),
    cycle_fabrication: z.number().int().optional().nullable(),
    code_client: z.string().optional().nullable(),
    client_name: z.string().optional().nullable(),
    ensemble: z.boolean().default(false),

    bom: z.array(bomLineSchema).default([]),
    operations: z.array(operationSchema).default([]),
    achats: z.array(achatSchema).default([]),
  }),
})

export const idParamSchema = z.object({
  params: z.object({ id: z.string().uuid("id must be a uuid") }),
})

export function validate(schema: z.ZodTypeAny) {
  return (req: any, res: any, next: any) => {
    const parsed = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    })
    if (!parsed.success) {
      const msg = parsed.error.issues?.[0]?.message ?? "Invalid request"
      return res.status(400).json({ error: msg })
    }
    next()
  }
}
