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

export const avoirIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const listAvoirsQuerySchema = z.object({
  q: z.string().optional(),
  client_id: z.string().optional(),
  facture_id: z.coerce.number().int().positive().optional(),
  statut: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["numero", "date_emission", "total_ttc", "updated_at"]).optional().default("date_emission"),
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

export type ListAvoirsQueryDTO = z.infer<typeof listAvoirsQuerySchema>;

export const getAvoirQuerySchema = z.object({
  include: z
    .preprocess((value) => {
      if (value === undefined || value === null) return "client,lignes,documents,facture";
      if (Array.isArray(value)) return value.join(",");
      if (typeof value === "string") return value;
      return "client,lignes,documents,facture";
    }, z.string())
    .optional()
    .default("client,lignes,documents,facture"),
});

const avoirLineSchema = z.object({
  designation: z.string().trim().min(1),
  code_piece: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  quantite: z.coerce.number().positive().optional().default(1),
  unite: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  prix_unitaire_ht: z.coerce.number().min(0),
  remise_ligne: z.coerce.number().min(0).max(100).optional().default(0),
  taux_tva: z.coerce.number().min(0).max(100).optional().default(20),
});

export const createAvoirBodySchema = z.object({
  numero: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(30)).optional(),
  client_id: z.string().trim().min(1),
  facture_id: z.coerce.number().int().positive().optional().nullable(),
  date_emission: z.preprocess(emptyStringToUndefined, isoDate).optional(),
  statut: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(40)).optional().default("brouillon"),
  motif: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  lignes: z.array(avoirLineSchema).min(1),
});

export type CreateAvoirBodyDTO = z.infer<typeof createAvoirBodySchema>;

export const updateAvoirBodySchema = z.object({
  numero: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(30)).optional(),
  client_id: z.string().trim().min(1).optional(),
  facture_id: z.coerce.number().int().positive().optional().nullable(),
  date_emission: z.preprocess(emptyStringToUndefined, isoDate).optional(),
  statut: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(40)).optional(),
  motif: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  lignes: z.array(avoirLineSchema).min(1).optional(),
});

export type UpdateAvoirBodyDTO = z.infer<typeof updateAvoirBodySchema>;
