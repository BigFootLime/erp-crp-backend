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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const devisIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const listDevisQuerySchema = z.object({
  q: z.string().optional(),
  client_id: z.string().optional(),
  statut: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z
    .enum(["numero", "date_creation", "date_validite", "statut", "total_ttc", "total_ht", "updated_at"])
    .optional()
    .default("date_creation"),
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

export type ListDevisQueryDTO = z.infer<typeof listDevisQuerySchema>;

export const getDevisQuerySchema = z.object({
  include: z
    .preprocess((value) => {
      if (value === undefined || value === null) return "client,lignes,documents";
      if (Array.isArray(value)) return value.join(",");
      if (typeof value === "string") return value;
      return "client,lignes,documents";
    }, z.string())
    .optional()
    .default("client,lignes,documents"),
});

const devisLineSchema = z.preprocess((value) => {
  if (!isRecord(value)) return value;
  const v = value;
  if (typeof v.description !== "string" && typeof v.designation === "string") {
    return { ...v, description: v.designation };
  }
  return v;
},
z.object({
  description: z.string().trim().min(1),
  quantite: z.coerce.number().positive().optional().default(1),
  unite: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  prix_unitaire_ht: z.coerce.number().min(0),
  remise_ligne: z.coerce.number().min(0).max(100).optional().default(0),
  taux_tva: z.coerce.number().min(0).max(100).optional().default(20),
}));

export const createDevisBodySchema = z.object({
  numero: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(30)).optional(),
  client_id: z.string().trim().min(1),
  contact_id: z.string().uuid().optional().nullable(),
  user_id: z.coerce.number().int().positive().optional(),
  adresse_facturation_id: z.string().uuid().optional().nullable(),
  adresse_livraison_id: z.string().uuid().optional().nullable(),
  mode_reglement_id: z.string().uuid().optional().nullable(),
  compte_vente_id: z.string().uuid().optional().nullable(),
  date_validite: z.preprocess(emptyStringToNull, isoDate).optional().nullable(),
  statut: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(20)).optional().default("BROUILLON"),
  remise_globale: z.coerce.number().min(0).optional().default(0),
  total_ht: z.coerce.number().min(0).optional().default(0),
  total_ttc: z.coerce.number().min(0).optional().default(0),
  commentaires: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  conditions_paiement_id: z.coerce.number().int().positive().optional().nullable(),
  biller_id: z.string().uuid().optional().nullable(),
  lignes: z.array(devisLineSchema).min(1),
});

export type CreateDevisBodyDTO = z.infer<typeof createDevisBodySchema>;

export const updateDevisBodySchema = z.object({
  numero: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(30)).optional(),
  client_id: z.string().trim().min(1).optional(),
  contact_id: z.string().uuid().optional().nullable(),
  user_id: z.coerce.number().int().positive().optional(),
  adresse_facturation_id: z.string().uuid().optional().nullable(),
  adresse_livraison_id: z.string().uuid().optional().nullable(),
  mode_reglement_id: z.string().uuid().optional().nullable(),
  compte_vente_id: z.string().uuid().optional().nullable(),
  date_validite: z.preprocess(emptyStringToNull, isoDate).optional().nullable(),
  statut: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(20)).optional(),
  remise_globale: z.coerce.number().min(0).optional(),
  total_ht: z.coerce.number().min(0).optional(),
  total_ttc: z.coerce.number().min(0).optional(),
  commentaires: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  conditions_paiement_id: z.coerce.number().int().positive().optional().nullable(),
  biller_id: z.string().uuid().optional().nullable(),
  lignes: z.array(devisLineSchema).optional(),
});

export type UpdateDevisBodyDTO = z.infer<typeof updateDevisBodySchema>;
