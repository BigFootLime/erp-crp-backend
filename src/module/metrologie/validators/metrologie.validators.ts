import { z } from "zod";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date (expected YYYY-MM-DD)");

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "y") return true;
  if (v === "false" || v === "0" || v === "no" || v === "n") return false;
  return undefined;
}

export const sortDirSchema = z.enum(["asc", "desc"]);

export const metrologieCriticiteSchema = z.enum(["NORMAL", "CRITIQUE"]);
export type MetrologieCriticiteDTO = z.infer<typeof metrologieCriticiteSchema>;

export const metrologieEquipementStatutSchema = z.enum(["ACTIF", "INACTIF", "REBUT"]);
export type MetrologieEquipementStatutDTO = z.infer<typeof metrologieEquipementStatutSchema>;

export const metrologiePlanStatutSchema = z.enum(["EN_COURS", "SUSPENDU"]);
export type MetrologiePlanStatutDTO = z.infer<typeof metrologiePlanStatutSchema>;

export const metrologieCertificatResultatSchema = z.enum(["CONFORME", "NON_CONFORME", "AJUSTAGE"]);
export type MetrologieCertificatResultatDTO = z.infer<typeof metrologieCertificatResultatSchema>;

export const equipementIdParamSchema = z.object({
  params: z.object({ id: uuid }),
});

export const certificatIdParamSchema = z.object({
  params: z.object({
    id: uuid,
    certificatId: uuid,
  }),
});

export const listEquipementsQuerySchema = z.object({
  q: z.string().trim().optional(),
  criticite: metrologieCriticiteSchema.optional(),
  statut: metrologieEquipementStatutSchema.optional(),
  overdue: z.preprocess(parseBoolean, z.boolean().optional()),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["updated_at", "created_at", "designation", "code", "next_due_date"]).optional().default("updated_at"),
  sortDir: sortDirSchema.optional().default("desc"),
});

export type ListEquipementsQueryDTO = z.infer<typeof listEquipementsQuerySchema>;

export const createEquipementSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(80).optional().nullable(),
      designation: z.string().trim().min(1).max(400),
      categorie: z.string().trim().min(1).max(120).optional().nullable(),
      marque: z.string().trim().min(1).max(120).optional().nullable(),
      modele: z.string().trim().min(1).max(120).optional().nullable(),
      numero_serie: z.string().trim().min(1).max(200).optional().nullable(),
      localisation: z.string().trim().min(1).max(200).optional().nullable(),
      criticite: metrologieCriticiteSchema.optional().default("NORMAL"),
      statut: metrologieEquipementStatutSchema.optional().default("ACTIF"),
      notes: z.string().trim().min(1).optional().nullable(),
    })
    .strict(),
});

export type CreateEquipementBodyDTO = z.infer<typeof createEquipementSchema>["body"];

export const patchEquipementSchema = z.object({
  body: z.object({
    note: z.string().trim().min(1).max(2000).optional().nullable(),
    patch: z
      .object({
        code: z.string().trim().min(1).max(80).optional().nullable(),
        designation: z.string().trim().min(1).max(400).optional(),
        categorie: z.string().trim().min(1).max(120).optional().nullable(),
        marque: z.string().trim().min(1).max(120).optional().nullable(),
        modele: z.string().trim().min(1).max(120).optional().nullable(),
        numero_serie: z.string().trim().min(1).max(200).optional().nullable(),
        localisation: z.string().trim().min(1).max(200).optional().nullable(),
        criticite: metrologieCriticiteSchema.optional(),
        statut: metrologieEquipementStatutSchema.optional(),
        notes: z.string().trim().min(1).optional().nullable(),
      })
      .strict(),
  }),
});

export type PatchEquipementBodyDTO = z.infer<typeof patchEquipementSchema>["body"];

export const upsertPlanSchema = z.object({
  body: z
    .object({
      periodicite_mois: z.coerce.number().int().positive(),
      last_done_date: isoDate.optional().nullable(),
      next_due_date: isoDate.optional().nullable(),
      statut: metrologiePlanStatutSchema.optional().default("EN_COURS"),
      commentaire: z.string().trim().min(1).max(5000).optional().nullable(),
    })
    .strict(),
});

export type UpsertPlanBodyDTO = z.infer<typeof upsertPlanSchema>["body"];

export const createCertificatSchema = z.object({
  body: z
    .object({
      date_etalonnage: isoDate,
      date_echeance: isoDate.optional().nullable(),
      resultat: metrologieCertificatResultatSchema,
      organisme: z.string().trim().min(1).max(200).optional().nullable(),
      commentaire: z.string().trim().min(1).max(5000).optional().nullable(),
    })
    .strict(),
});

export type CreateCertificatBodyDTO = z.infer<typeof createCertificatSchema>["body"];
