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

export const affaireIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const affaireStatutSchema = z.enum(["OUVERTE", "EN_COURS", "SUSPENDUE", "CLOTUREE", "ANNULEE"]);
export const affaireTypeSchema = z.enum(["fabrication", "previsionnel", "regroupement"]);

export const listAffairesQuerySchema = z.object({
  q: z.string().optional(),
  client_id: z.string().optional(),
  statut: affaireStatutSchema.optional(),
  type_affaire: affaireTypeSchema.optional(),

  open_from: isoDate.optional(),
  open_to: isoDate.optional(),
  close_from: isoDate.optional(),
  close_to: isoDate.optional(),

  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),

  sortBy: z.enum(["reference", "date_ouverture", "updated_at"]).optional().default("updated_at"),
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

export type ListAffairesQueryDTO = z.infer<typeof listAffairesQuerySchema>;

export const getAffaireQuerySchema = z.object({
  include: z
    .preprocess((value) => {
      if (value === undefined || value === null) return "";
      if (Array.isArray(value)) return value.join(",");
      if (typeof value === "string") return value;
      return "";
    }, z.string())
    .optional()
    .default(""),
});

export const createAffaireBodySchema = z.object({
  reference: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(30)).optional(),
  client_id: z.string().trim().min(1),
  commande_id: z.coerce.number().int().positive().optional().nullable(),
  devis_id: z.coerce.number().int().positive().optional().nullable(),
  type_affaire: affaireTypeSchema.optional().default("fabrication"),
  statut: affaireStatutSchema.optional().default("OUVERTE"),
  date_ouverture: z.preprocess(emptyStringToUndefined, isoDate).optional(),
  date_cloture: z.preprocess(emptyStringToNull, isoDate).optional().nullable(),
  commentaire: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
});

export type CreateAffaireBodyDTO = z.infer<typeof createAffaireBodySchema>;

export const updateAffaireBodySchema = z.object({
  reference: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(30)).optional(),
  client_id: z.string().trim().min(1).optional(),
  commande_id: z.coerce.number().int().positive().optional().nullable(),
  devis_id: z.coerce.number().int().positive().optional().nullable(),
  type_affaire: affaireTypeSchema.optional(),
  statut: affaireStatutSchema.optional(),
  date_ouverture: z.preprocess(emptyStringToUndefined, isoDate).optional(),
  date_cloture: z.preprocess(emptyStringToNull, isoDate).optional().nullable(),
  commentaire: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
});

export type UpdateAffaireBodyDTO = z.infer<typeof updateAffaireBodySchema>;
