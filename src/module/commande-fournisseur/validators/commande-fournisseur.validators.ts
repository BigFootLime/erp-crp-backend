import { z } from "zod";

import {
  COMMANDE_FOURNISSEUR_STATUTS,
} from "../domain/commande-fournisseur-transitions";

/**
 * Validation Zod stricte (#172) — params/query/body en mode strict : les champs inconnus
 * sensibles sont rejetés. Le `code` est volontairement absent de toute écriture : il est
 * généré côté serveur (BCF-AAAA-NNNN) et immuable. Pagination/tri/filtres bornés.
 */

const uuid = z.string().uuid();
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ")
  .refine((v) => {
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  }, "Date calendaire invalide");
const isoDateTime = z.string().datetime({ offset: true });
const money = z.number().finite().min(0).max(99_999_999);
const pct = z.number().finite().min(0).max(100);
const qty = z.number().finite().gt(0).max(9_999_999);
const positiveInt = z.number().int().min(0).max(100_000);
const shortText = z.string().trim().min(1).max(200);
const longText = z.string().trim().max(4000);

export const ORIGINES = ["MANUEL", "SEUIL_STOCK", "RUPTURE_OF", "PROPOSITION_MRP", "SOUS_TRAITANCE", "AUTRE"] as const;
export const LIGNE_TYPES = ["ARTICLE", "MATIERE", "COMPOSANT", "SOUS_TRAITANCE", "PRESTATION", "LIBRE_CONTROLEE"] as const;
export const INCOTERMS = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"] as const;

export const commandeFournisseurStatutSchema = z.enum(COMMANDE_FOURNISSEUR_STATUTS);

/* ----------------------------- params / query ----------------------------- */

export const commandeIdParamSchema = z.object({
  params: z.object({ id: uuid }).strict(),
});

export const ligneIdParamSchema = z.object({
  params: z.object({ id: uuid, ligneId: uuid }).strict(),
});

export const documentIdParamSchema = z.object({
  params: z.object({ id: uuid, documentId: uuid }).strict(),
});

export const listCommandesQuerySchema = z.object({
  query: z
    .object({
      q: z.string().trim().max(120).optional(),
      statut: z
        .union([commandeFournisseurStatutSchema, z.array(commandeFournisseurStatutSchema).max(9)])
        .optional(),
      fournisseur_id: uuid.optional(),
      origine: z.enum(ORIGINES).optional(),
      en_retard: z.enum(["true", "false"]).optional(),
      date_from: dateOnly.optional(),
      date_to: dateOnly.optional(),
      page: z.coerce.number().int().min(1).max(10_000).default(1),
      page_size: z.coerce.number().int().min(1).max(100).default(25),
      sort: z.enum(["created_at", "date_besoin", "date_promesse", "code", "total_ttc", "updated_at"]).default("created_at"),
      dir: z.enum(["asc", "desc"]).default("desc"),
    })
    .strict(),
});

/* --------------------------------- lignes --------------------------------- */

const exigenceQualiteSchema = z
  .object({
    type: z.enum([
      "CERTIFICAT_MATIERE",
      "CERTIFICAT_CONFORMITE",
      "LOT",
      "COULEE",
      "PLAN_INDICE",
      "SPECIFICATION",
      "CONTROLE_RECEPTION",
      "AUTRE",
    ]),
    valeur: z.string().trim().max(300).optional(),
    obligatoire: z.boolean().default(true),
  })
  .strict();

export const ligneInputSchema = z
  .object({
    type: z.enum(LIGNE_TYPES).default("ARTICLE"),
    article_id: uuid.nullish(),
    catalogue_id: uuid.nullish(),
    reference_fournisseur: z.string().trim().max(120).nullish(),
    designation: shortText,
    designation_interne: z.string().trim().max(200).nullish(),
    unite: z.string().trim().max(20).nullish(),
    unite_stock: z.string().trim().max(20).nullish(),
    coef_conversion: z.number().finite().gt(0).max(1_000_000).nullish(),
    quantite: qty,
    prix_unitaire_ht: money.default(0),
    remise_pct: pct.default(0),
    tva_pct: pct.default(20),
    frais_ht: money.default(0),
    date_besoin: dateOnly.nullish(),
    date_promesse: dateOnly.nullish(),
    delai_jours: positiveInt.nullish(),
    affaire_id: z.number().int().positive().nullish(),
    commande_client_id: z.number().int().positive().nullish(),
    of_id: z.number().int().positive().nullish(),
    piece_technique_id: uuid.nullish(),
    operation_libelle: z.string().trim().max(200).nullish(),
    magasin_id: uuid.nullish(),
    exigences_qualite: z.array(exigenceQualiteSchema).max(20).default([]),
    documents_attendus: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    besoins: z
      .array(
        z
          .object({
            besoin_type: z.enum(["PIECE_TECHNIQUE_ACHAT", "STOCK_LEVEL", "MANUEL"]),
            besoin_ref: z.string().trim().min(1).max(120),
            of_id: z.number().int().positive().nullish(),
            quantite_couverte: qty,
          })
          .strict()
      )
      .max(20)
      .default([]),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.type !== "LIBRE_CONTROLEE" && val.type !== "PRESTATION" && !val.article_id && !val.catalogue_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["article_id"],
        message: "Un article ou une entrée de catalogue est requis pour ce type de ligne.",
      });
    }
    if ((val.coef_conversion == null) !== (val.unite_stock == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coef_conversion"],
        message: "Conversion d'unité incomplète : fournir l'unité de stock ET le coefficient.",
      });
    }
  });

/* --------------------------------- création -------------------------------- */

export const createCommandeSchema = z.object({
  body: z
    .object({
      idempotency_key: z.string().trim().min(8).max(120).optional(),
      origine: z.enum(ORIGINES).default("MANUEL"),
      fournisseur_id: uuid,
      contact_id: uuid.nullish(),
      adresse_commande_id: uuid.nullish(),
      magasin_livraison_id: uuid.nullish(),
      adresse_livraison_texte: longText.nullish(),
      adresse_facturation_texte: longText.nullish(),
      devise: z.string().trim().length(3).toUpperCase().default("EUR"),
      conditions_paiement: z.string().trim().max(200).nullish(),
      incoterm: z.enum(INCOTERMS).nullish(),
      mode_transport: z.string().trim().max(120).nullish(),
      date_besoin: dateOnly.nullish(),
      commentaire_public: longText.nullish(),
      note_interne: longText.nullish(),
      frais_port_ht: money.default(0),
      tva_frais_pct: pct.default(20),
      lignes: z.array(ligneInputSchema).min(0).max(200).default([]),
    })
    .strict(),
});
export type CreateCommandeBodyDTO = z.infer<typeof createCommandeSchema>["body"];

/* ------------------------------ PATCH (tri-state) --------------------------- */

export const updateCommandeSchema = z.object({
  body: z
    .object({
      expected_updated_at: isoDateTime.optional(),
      contact_id: uuid.nullish(),
      adresse_commande_id: uuid.nullish(),
      magasin_livraison_id: uuid.nullish(),
      adresse_livraison_texte: longText.nullish(),
      adresse_facturation_texte: longText.nullish(),
      devise: z.string().trim().length(3).toUpperCase().optional(),
      conditions_paiement: z.string().trim().max(200).nullish(),
      incoterm: z.enum(INCOTERMS).nullish(),
      mode_transport: z.string().trim().max(120).nullish(),
      date_besoin: dateOnly.nullish(),
      commentaire_public: longText.nullish(),
      note_interne: longText.nullish(),
      frais_port_ht: money.optional(),
      tva_frais_pct: pct.optional(),
      origine: z.enum(ORIGINES).optional(),
    })
    .strict(),
});
export type UpdateCommandeBodyDTO = z.infer<typeof updateCommandeSchema>["body"];

export const addLigneSchema = z.object({
  body: z.object({ ligne: ligneInputSchema, expected_updated_at: isoDateTime.optional() }).strict(),
});
export type AddLigneBodyDTO = z.infer<typeof addLigneSchema>["body"];

export const updateLigneSchema = z.object({
  body: z
    .object({
      expected_updated_at: isoDateTime.optional(),
      patch: ligneInputSchema
        .innerType()
        .partial()
        .strict(),
    })
    .strict(),
});
export type UpdateLigneBodyDTO = z.infer<typeof updateLigneSchema>["body"];

export const deleteLigneSchema = z.object({
  body: z.object({ expected_updated_at: isoDateTime.optional() }).strict().optional(),
});

export const reorderLignesSchema = z.object({
  body: z
    .object({
      expected_updated_at: isoDateTime.optional(),
      ordre: z.array(uuid).min(1).max(200),
    })
    .strict(),
});
export type ReorderLignesBodyDTO = z.infer<typeof reorderLignesSchema>["body"];

/* ------------------------------- transitions -------------------------------- */

export const transitionSchema = z.object({
  body: z
    .object({
      to: commandeFournisseurStatutSchema,
      motif: z.string().trim().min(3).max(1000).optional(),
      expected_updated_at: isoDateTime.optional(),
      idempotency_key: z.string().trim().min(8).max(120).optional(),
    })
    .strict(),
});
export type TransitionBodyDTO = z.infer<typeof transitionSchema>["body"];

export const accuseSchema = z.object({
  body: z
    .object({
      reference_fournisseur: shortText,
      date_accuse: isoDateTime.optional(),
      date_promesse: dateOnly.nullish(),
      expected_updated_at: isoDateTime.optional(),
    })
    .strict(),
});
export type AccuseBodyDTO = z.infer<typeof accuseSchema>["body"];

export const generateDocumentSchema = z.object({
  body: z
    .object({
      motif_revision: z.string().trim().min(3).max(500).optional(),
      expected_updated_at: isoDateTime.optional(),
    })
    .strict()
    .optional(),
});
export type GenerateDocumentBodyDTO = z.infer<typeof generateDocumentSchema>["body"];

export const simulateTotauxSchema = z.object({
  body: z
    .object({
      frais_port_ht: money.default(0),
      tva_frais_pct: pct.default(20),
      lignes: z
        .array(
          z
            .object({
              quantite: qty,
              prix_unitaire_ht: money.default(0),
              remise_pct: pct.default(0),
              tva_pct: pct.default(20),
              frais_ht: money.default(0),
            })
            .strict()
        )
        .max(200),
    })
    .strict(),
});
export type SimulateTotauxBodyDTO = z.infer<typeof simulateTotauxSchema>["body"];

/* ------------------------------- propositions ------------------------------- */

export const propositionsPreviewSchema = z.object({
  body: z
    .object({
      origines: z.array(z.enum(["SEUIL_STOCK", "RUPTURE_OF"])).min(1).max(2),
      of_ids: z.array(z.number().int().positive()).max(50).optional(),
      fournisseur_id: uuid.optional(),
      limit: z.number().int().min(1).max(200).default(100),
    })
    .strict(),
});
export type PropositionsPreviewBodyDTO = z.infer<typeof propositionsPreviewSchema>["body"];

export const propositionsConfirmSchema = z.object({
  body: z
    .object({
      idempotency_key: z.string().trim().min(8).max(120),
      groupes: z
        .array(
          z
            .object({
              fournisseur_id: uuid,
              devise: z.string().trim().length(3).toUpperCase().default("EUR"),
              date_besoin: dateOnly.nullish(),
              lignes: z
                .array(
                  z
                    .object({
                      besoin_type: z.enum(["PIECE_TECHNIQUE_ACHAT", "STOCK_LEVEL"]),
                      besoin_ref: z.string().trim().min(1).max(120),
                      of_id: z.number().int().positive().nullish(),
                      article_id: uuid.nullish(),
                      catalogue_id: uuid.nullish(),
                      type: z.enum(LIGNE_TYPES).default("ARTICLE"),
                      designation: shortText,
                      quantite: qty,
                      unite: z.string().trim().max(20).nullish(),
                      prix_unitaire_ht: money.default(0),
                      tva_pct: pct.default(20),
                      date_besoin: dateOnly.nullish(),
                      delai_jours: positiveInt.nullish(),
                    })
                    .strict()
                )
                .min(1)
                .max(100),
            })
            .strict()
        )
        .min(1)
        .max(20),
    })
    .strict(),
});
export type PropositionsConfirmBodyDTO = z.infer<typeof propositionsConfirmSchema>["body"];

/* -------------------------------- duplication ------------------------------- */

export const duplicateSchema = z.object({
  body: z.object({ note: z.string().trim().max(500).optional() }).strict().optional(),
});
