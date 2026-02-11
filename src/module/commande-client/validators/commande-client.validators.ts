import type { RequestHandler } from "express";
import { z } from "zod";

const boolFromQuery = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return value;
}, z.boolean());

export const commandeLigneInputSchema = z.object({
  designation: z.string().min(1),
  code_piece: z.string().optional().nullable(),
  quantite: z.number().positive(),
  unite: z.string().optional().nullable(),
  prix_unitaire_ht: z.number().min(0),
  remise_ligne: z.number().min(0).max(100).optional().default(0),
  taux_tva: z.number().min(0).max(100).optional().default(20),
  delai_client: z.string().optional().nullable(),
  delai_interne: z.string().optional().nullable(),
  devis_numero: z.string().optional().nullable(),
  famille: z.string().optional().nullable(),
});

export const commandeEcheanceInputSchema = z.object({
  libelle: z.string().min(1),
  date_echeance: z.string().min(1),
  pourcentage: z.number().min(0).max(100),
  montant: z.number().min(0),
});

export const createCommandeBodySchema = z.preprocess((value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v.echeances === undefined && Array.isArray(v.echeancier)) {
      return { ...v, echeances: v.echeancier };
    }
  }
  return value;
},
z.object({
  numero: z.string().min(1),
  client_id: z.string().min(1),
  date_commande: z.string().min(1),
  contact_id: z.string().uuid().optional().nullable(),
  destinataire_id: z.string().uuid().optional().nullable(),
  emetteur: z.string().optional().nullable(),
  code_client: z.string().optional().nullable(),
  arc_edi: z.boolean().optional().default(false),
  arc_date_envoi: z.string().optional().nullable(),
  compteur_affaire_id: z.string().uuid().optional().nullable(),
  type_affaire: z.enum(["fabrication", "previsionnel", "regroupement"]).optional().default("fabrication"),
  mode_port_id: z.string().uuid().optional().nullable(),
  mode_reglement_id: z.string().uuid().optional().nullable(),
  conditions_paiement_id: z.number().int().optional().nullable(),
  biller_id: z.string().uuid().optional().nullable(),
  compte_vente_id: z.string().uuid().optional().nullable(),
  commentaire: z.string().optional().nullable(),
  remise_globale: z.number().min(0).optional().default(0),
  total_ht: z.number().min(0).optional().default(0),
  total_ttc: z.number().min(0).optional().default(0),
  lignes: z.array(commandeLigneInputSchema).min(1),
  echeances: z.array(commandeEcheanceInputSchema).optional().default([]),
}));

export type CreateCommandeBodyDTO = z.infer<typeof createCommandeBodySchema>;

export const updateCommandeStatusBodySchema = z.object({
  nouveau_statut: z.string().min(1),
  commentaire: z.string().optional().nullable(),
});

export type UpdateCommandeStatusBodyDTO = z.infer<typeof updateCommandeStatusBodySchema>;

export const listCommandesQuerySchema = z.object({
  q: z.string().optional(),
  client_id: z.string().optional(),
  statut: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  min_total_ttc: z.coerce.number().optional(),
  max_total_ttc: z.coerce.number().optional(),
  mine_recent: boolFromQuery.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["numero", "date_commande", "updated_at", "total_ttc"]).optional().default("updated_at"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type ListCommandesQueryDTO = z.infer<typeof listCommandesQuerySchema>;

export const idParamSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, "id must be an integer"),
  }),
});

export function validate(schema: z.ZodTypeAny): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!parsed.success) {
      const msg = parsed.error.issues?.[0]?.message ?? "Invalid request";
      res.status(400).json({ error: msg });
      return;
    }
    next();
  };
}
