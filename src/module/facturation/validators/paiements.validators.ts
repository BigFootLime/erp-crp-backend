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

export const paiementIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const listPaiementsQuerySchema = z.object({
  q: z.string().optional(),
  client_id: z.string().optional(),
  facture_id: z.coerce.number().int().positive().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["date_paiement", "montant", "updated_at"]).optional().default("date_paiement"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
  include: z
    .preprocess((value) => {
      if (value === undefined || value === null) return "client,facture";
      if (Array.isArray(value)) return value.join(",");
      if (typeof value === "string") return value;
      return "client,facture";
    }, z.string())
    .optional()
    .default("client,facture"),
});

export type ListPaiementsQueryDTO = z.infer<typeof listPaiementsQuerySchema>;

export const getPaiementQuerySchema = z.object({
  include: z
    .preprocess((value) => {
      if (value === undefined || value === null) return "client,facture";
      if (Array.isArray(value)) return value.join(",");
      if (typeof value === "string") return value;
      return "client,facture";
    }, z.string())
    .optional()
    .default("client,facture"),
});

export const createPaiementBodySchema = z.object({
  facture_id: z.coerce.number().int().positive(),
  client_id: z.preprocess(emptyStringToUndefined, z.string().trim().min(1)).optional(),
  date_paiement: z.preprocess(emptyStringToUndefined, isoDate).optional(),
  montant: z.coerce.number().min(0),
  mode: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  reference: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  commentaire: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
});

export type CreatePaiementBodyDTO = z.infer<typeof createPaiementBodySchema>;

export const updatePaiementBodySchema = z.object({
  facture_id: z.coerce.number().int().positive().optional(),
  client_id: z.preprocess(emptyStringToUndefined, z.string().trim().min(1)).optional(),
  date_paiement: z.preprocess(emptyStringToUndefined, isoDate).optional(),
  montant: z.coerce.number().min(0).optional(),
  mode: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  reference: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  commentaire: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
});

export type UpdatePaiementBodyDTO = z.infer<typeof updatePaiementBodySchema>;
