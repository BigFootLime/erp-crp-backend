import type { RequestHandler } from "express";
import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date (expected YYYY-MM-DD)");

export const commandeOrderTypeSchema = z.enum(["FERME", "CADRE", "INTERNE"]);

export const cadreReleaseStatusSchema = z.enum(["PLANNED", "SENT", "CONFIRMED", "DELIVERED", "CANCELLED"]);

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
  order_type: commandeOrderTypeSchema.optional().default("FERME"),
  numero: z.string().trim().min(1).optional(),
  client_id: z.string().trim().min(1).optional().nullable(),
  date_commande: isoDate,
  contact_id: z.string().uuid().optional().nullable(),
  destinataire_id: z.string().uuid().optional().nullable(),
  adresse_facturation_id: z.string().uuid().optional().nullable(),
  emetteur: z.string().optional().nullable(),
  code_client: z.string().optional().nullable(),
  arc_edi: z.boolean().optional().default(false),
  arc_date_envoi: z.string().optional().nullable(),
  compteur_affaire_id: z.string().uuid().optional().nullable(),
  type_affaire: z.enum(["fabrication", "previsionnel", "regroupement"]).optional().default("fabrication"),

  cadre_start_date: isoDate.optional().nullable(),
  cadre_end_date: isoDate.optional().nullable(),
 
  dest_stock_magasin_id: z.string().uuid().optional().nullable(),
  dest_stock_emplacement_id: z
    .preprocess((value) => {
      if (value === null || value === undefined) return value;
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      if (typeof value === "string") return value.trim();
      return value;
    }, z.string().min(1))
    .optional()
    .nullable(),

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
}))
  .superRefine((val, ctx) => {
    if (val.order_type !== "INTERNE") {
      const clientId = typeof val.client_id === "string" ? val.client_id.trim() : "";
      if (!clientId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "client_id is required for customer orders",
          path: ["client_id"],
        });
      }
    }

    if (val.order_type === "INTERNE") {
      if (!(typeof val.dest_stock_magasin_id === "string" && val.dest_stock_magasin_id.trim().length > 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "dest_stock_magasin_id is required for internal orders",
          path: ["dest_stock_magasin_id"],
        });
      }

      val.lignes.forEach((l, i) => {
        const codePiece = (l.code_piece ?? "").toString().trim();
        if (!codePiece) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "code_piece is required for internal order lines",
            path: ["lignes", i, "code_piece"],
          });
        }
      });
    }

    if (val.order_type === "CADRE") {
      if (val.cadre_start_date && val.cadre_end_date) {
        const start = new Date(val.cadre_start_date).getTime();
        const end = new Date(val.cadre_end_date).getTime();
        if (Number.isFinite(start) && Number.isFinite(end) && start > end) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "cadre_start_date must be <= cadre_end_date",
            path: ["cadre_end_date"],
          });
        }
      }
    }
  });

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
  order_type: commandeOrderTypeSchema.optional(),
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

export const releaseIdParamSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, "id must be an integer"),
    releaseId: z.string().regex(/^\d+$/, "releaseId must be an integer"),
  }),
});

export const releaseLineIdParamSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, "id must be an integer"),
    releaseId: z.string().regex(/^\d+$/, "releaseId must be an integer"),
    lineId: z.string().regex(/^\d+$/, "lineId must be an integer"),
  }),
});

export const documentIdParamSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, "id must be an integer"),
    docId: z.string().uuid("docId must be a UUID"),
  }),
});

export const createCadreReleaseLineBodySchema = z.object({
  ordre: z.coerce.number().int().positive().optional(),
  commande_ligne_id: z.coerce.number().int().positive().optional().nullable(),
  designation: z.string().trim().min(1).max(10000),
  code_piece: z.string().trim().min(1).max(200).optional().nullable(),
  quantite: z.coerce.number().positive(),
  unite: z.string().trim().min(1).max(30).optional().nullable(),
  delai_client: z.string().trim().min(1).max(100).optional().nullable(),
});

export type CreateCadreReleaseLineBodyDTO = z.infer<typeof createCadreReleaseLineBodySchema>;

export const updateCadreReleaseLineBodySchema = z.object({
  ordre: z.coerce.number().int().positive().optional(),
  commande_ligne_id: z.coerce.number().int().positive().optional().nullable(),
  designation: z.string().trim().min(1).max(10000).optional(),
  code_piece: z.string().trim().min(1).max(200).optional().nullable(),
  quantite: z.coerce.number().positive().optional(),
  unite: z.string().trim().min(1).max(30).optional().nullable(),
  delai_client: z.string().trim().min(1).max(100).optional().nullable(),
});

export type UpdateCadreReleaseLineBodyDTO = z.infer<typeof updateCadreReleaseLineBodySchema>;

export const createCadreReleaseBodySchema = z
  .object({
    date_demande: isoDate.optional().default(() => new Date().toISOString().slice(0, 10)),
    date_livraison_prevue: isoDate.optional().nullable(),
    statut: cadreReleaseStatusSchema.optional().default("PLANNED"),
    notes: z.string().max(20000).optional().nullable(),
    lignes: z.array(createCadreReleaseLineBodySchema).optional().default([]),
  })
  .passthrough();

export type CreateCadreReleaseBodyDTO = z.infer<typeof createCadreReleaseBodySchema>;

export const updateCadreReleaseBodySchema = z
  .object({
    date_demande: isoDate.optional(),
    date_livraison_prevue: isoDate.optional().nullable(),
    statut: cadreReleaseStatusSchema.optional(),
    notes: z.string().max(20000).optional().nullable(),
  })
  .passthrough();

export type UpdateCadreReleaseBodyDTO = z.infer<typeof updateCadreReleaseBodySchema>;

/* -------------------------------------------------------------------------- */
/* Affaires generation confirmation (stock partial arbitration)                */
/* -------------------------------------------------------------------------- */

export const affairesGenerationStrategySchema = z.enum([
  "AUTO",
  "DELIVER_NOW",
  "RESERVE_AND_PRODUCE",
]);

export type AffairesGenerationStrategyDTO = z.infer<typeof affairesGenerationStrategySchema>;

export const generateAffairesSchema = z
  .object({
    params: z.object({
      id: z.string().regex(/^\d+$/, "id must be an integer"),
    }),
    body: z
      .object({
        strategy: affairesGenerationStrategySchema,
        production_quantities: z
          .array(
            z
              .object({
                commande_ligne_id: z.coerce.number().int().positive(),
                qty_to_produce: z.coerce.number().min(0),
              })
              .strict()
          )
          .optional()
          .default([]),
      })
      .strict(),
  })
  .strict();

export type GenerateAffairesBodyDTO = z.infer<typeof generateAffairesSchema>["body"];

export const generateAffairesChoiceSchema = z.enum([
  "DELIVER_AVAILABLE",
  "RESERVE_AND_PRODUCE_REST",
]);

export type GenerateAffairesChoiceDTO = z.infer<typeof generateAffairesChoiceSchema>;

export const confirmGenerateAffairesSchema = z
  .object({
    params: z.object({
      id: z.string().regex(/^\d+$/, "id must be an integer"),
    }),
    body: z
      .object({
        choice: generateAffairesChoiceSchema,
        production_quantities: z
          .array(
            z
              .object({
                commande_ligne_id: z.coerce.number().int().positive(),
                qty_to_produce: z.coerce.number().min(0),
              })
              .strict()
          )
          .optional()
          .default([]),
      })
      .strict(),
  })
  .strict();

export type ConfirmGenerateAffairesBodyDTO = z.infer<typeof confirmGenerateAffairesSchema>["body"];

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
