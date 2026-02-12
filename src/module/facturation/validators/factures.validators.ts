import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date (expected YYYY-MM-DD)");

function emptyStringToUndefined(value: unknown) {
  if (typeof value !== "string") return value;
  return value.trim() === "" ? undefined : value;
}

function emptyStringToNull(value: unknown) {
  if (typeof value !== "string") return value;
  return value.trim() === "" ? null : value;
}

export const factureIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const listFacturesQuerySchema = z.object({
  q: z.string().optional(),
  client_id: z.string().optional(),
  statut: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["numero", "date_emission", "date_echeance", "total_ttc", "updated_at"]).optional().default("date_emission"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
  include: z
    .preprocess((value) => {
      if (value === undefined || value === null) return "client";
      if (Array.isArray(value)) return value.join(",");
      if (typeof value === "string") return value;
      return "client";
    }, z.string())
    .optional()
    .default("client"),
});

export type ListFacturesQueryDTO = z.infer<typeof listFacturesQuerySchema>;

export const getFactureQuerySchema = z.object({
  include: z
    .preprocess((value) => {
      if (value === undefined || value === null) return "client,lignes,documents,paiements";
      if (Array.isArray(value)) return value.join(",");
      if (typeof value === "string") return value;
      return "client,lignes,documents,paiements";
    }, z.string())
    .optional()
    .default("client,lignes,documents,paiements"),
});

const factureLineSchema = z.object({
  designation: z.string().trim().min(1),
  code_piece: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  quantite: z.coerce.number().positive().optional().default(1),
  unite: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  prix_unitaire_ht: z.coerce.number().min(0),
  remise_ligne: z.coerce.number().min(0).max(100).optional().default(0),
  taux_tva: z.coerce.number().min(0).max(100).optional().default(20),
});

export const createFactureBodySchema = z.object({
  numero: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(30)).optional(),
  client_id: z.string().trim().min(1),
  devis_id: z.coerce.number().int().positive().optional().nullable(),
  commande_id: z.coerce.number().int().positive().optional().nullable(),
  affaire_id: z.coerce.number().int().positive().optional().nullable(),
  date_emission: z.preprocess(emptyStringToUndefined, isoDate).optional(),
  date_echeance: z.preprocess(emptyStringToNull, isoDate).optional().nullable(),
  statut: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(40)).optional().default("brouillon"),
  remise_globale: z.coerce.number().min(0).optional().default(0),
  commentaires: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  lignes: z.array(factureLineSchema).min(1),
});

export type CreateFactureBodyDTO = z.infer<typeof createFactureBodySchema>;

export const updateFactureBodySchema = z.object({
  numero: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(30)).optional(),
  client_id: z.string().trim().min(1).optional(),
  devis_id: z.coerce.number().int().positive().optional().nullable(),
  commande_id: z.coerce.number().int().positive().optional().nullable(),
  affaire_id: z.coerce.number().int().positive().optional().nullable(),
  date_emission: z.preprocess(emptyStringToUndefined, isoDate).optional(),
  date_echeance: z.preprocess(emptyStringToNull, isoDate).optional().nullable(),
  statut: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(40)).optional(),
  remise_globale: z.coerce.number().min(0).optional(),
  commentaires: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  lignes: z.array(factureLineSchema).min(1).optional(),
});

export type UpdateFactureBodyDTO = z.infer<typeof updateFactureBodySchema>;
