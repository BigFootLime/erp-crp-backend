import { z } from "zod";

export const outilSchema = z.object({
  id_fabricant: z.coerce.number().int(),
  id_famille: z.coerce.number().int(),
  id_geometrie: z.coerce.number().int().nullable().optional(),

  codification: z.string().min(1),
  designation_outil_cnc: z.string().min(1),
  reference_fabricant: z.string().trim().min(1).optional(),

  profondeur_utile: z.coerce.number().nullable().optional(),
  matiere_usiner: z.string().nullable().optional(),
  utilisation: z.string().nullable().optional(),

  longueur_coupe: z.coerce.number().nullable().optional(),
  longueur_detalonnee: z.coerce.number().nullable().optional(),
  longueur_totale: z.coerce.number().nullable().optional(),

  diametre_nominal: z.coerce.number().nullable().optional(),
  diametre_queue: z.coerce.number().nullable().optional(),
  diametre_trou: z.coerce.number().nullable().optional(),
  diametre_detalonnee: z.coerce.number().nullable().optional(),

  angle_helice: z.coerce.number().nullable().optional(),
  angle_pointe: z.coerce.number().nullable().optional(),
  angle_filetage: z.coerce.number().nullable().optional(),

  norme_filetage: z.string().nullable().optional(),
  pas_filetage: z.coerce.number().nullable().optional(),

  type_arrosage: z.string().nullable().optional(),
  type_entree: z.string().nullable().optional(),
  nombre_dents: z.coerce.number().nullable().optional(),

  fournisseurs: z.array(z.coerce.number().int()).optional(),
  revetements: z.array(z.coerce.number().int()).optional(),

  valeurs_aretes: z.array(
    z.object({
      id_arete_coupe: z.coerce.number().int(),
      valeur: z.coerce.number(),
    })
  ).optional(),

  quantite_stock: z.coerce.number().int().nonnegative().optional().default(0),
  quantite_minimale: z.coerce.number().int().nonnegative().optional().default(0),

   esquisse_file: z.any().optional().nullable(),
  plan_file: z.any().optional().nullable(),
  image_file: z.any().optional().nullable(),

  // meta UI
  _created_at: z.string().optional(),
});

export type CreateOutilInput = z.infer<typeof outilSchema>;

/**
 * Scan / mouvements
 */
export const scanMovementSchema = z.object({
  barcode: z.string().trim().min(1),
  quantity: z.coerce.number().int().positive().optional().default(1),
  reason: z.string().trim().optional(),
  note: z.string().trim().optional(),
  affaire_id: z.coerce.number().int().positive().optional(),
});

export type ScanMovementInput = z.infer<typeof scanMovementSchema>;

export const adjustStockSchema = z.object({
  id_outil: z.coerce.number().int().positive(),
  new_qty: z.coerce.number().int().nonnegative(),
  reason: z.string().trim().optional().default("inventaire"),
  note: z.string().trim().optional(),
  affaire_id: z.coerce.number().int().positive().optional(),
});

export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
