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

export const tarificationIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const listTarificationClientsQuerySchema = z.object({
  q: z.string().optional(),
  client_id: z.string().optional(),
  active_on: isoDate.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["updated_at", "client_id"]).optional().default("updated_at"),
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

export type ListTarificationClientsQueryDTO = z.infer<typeof listTarificationClientsQuerySchema>;

export const getTarificationClientQuerySchema = z.object({
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

export const createTarificationClientBodySchema = z.object({
  client_id: z.string().trim().min(1),
  remise_globale_pct: z.coerce.number().min(0).max(100).optional().default(0),
  escompte_pct: z.coerce.number().min(0).max(100).optional().default(0),
  delai_paiement_jours: z.coerce.number().int().min(0).optional().nullable(),
  taux_tva_default: z.coerce.number().min(0).max(100).optional().default(20),
  valid_from: z.preprocess(emptyStringToNull, isoDate).optional().nullable(),
  valid_to: z.preprocess(emptyStringToNull, isoDate).optional().nullable(),
});

export type CreateTarificationClientBodyDTO = z.infer<typeof createTarificationClientBodySchema>;

export const updateTarificationClientBodySchema = z.object({
  client_id: z.preprocess(emptyStringToUndefined, z.string().trim().min(1)).optional(),
  remise_globale_pct: z.coerce.number().min(0).max(100).optional(),
  escompte_pct: z.coerce.number().min(0).max(100).optional(),
  delai_paiement_jours: z.coerce.number().int().min(0).optional().nullable(),
  taux_tva_default: z.coerce.number().min(0).max(100).optional(),
  valid_from: z.preprocess(emptyStringToNull, isoDate).optional().nullable(),
  valid_to: z.preprocess(emptyStringToNull, isoDate).optional().nullable(),
});

export type UpdateTarificationClientBodyDTO = z.infer<typeof updateTarificationClientBodySchema>;
