// Validators du module Méthodes. La validation d'entrée n'est pas la règle
// métier : le domaine (`methodes-policy.ts`) reste autoritaire sur les
// exigences qui dépendent du référentiel (programme obligatoire, tarif, phase).

import type { RequestHandler } from "express";
import { z } from "zod";

import { PROGRAM_NUMBER_MAX_LENGTH } from "../domain/methodes-policy";

const uuid = z.string().uuid();

export const COST_CENTER_STATUSES = ["ACTIF", "SUSPENDU", "ARCHIVE"] as const;

const familyCode = z
  .string()
  .trim()
  .min(1, "Code de famille requis")
  .max(24, "24 caractères au maximum")
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z0-9_]+$/.test(value), {
    message: "Le code de famille n'accepte que des lettres majuscules, des chiffres et des tirets bas.",
  });

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ");

const booleanish = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

/* -------------------------------------------------------------------------- */
/* Familles machine                                                           */
/* -------------------------------------------------------------------------- */

export const listFamiliesQuerySchema = z.object({
  include_inactive: booleanish.optional().default(false),
});

export const familyCodeParamSchema = z.object({ code: familyCode });

export const createFamilySchema = z.object({
  code: familyCode,
  libelle: z.string().trim().min(2, "Libellé requis").max(120),
  description: z.string().trim().max(500).optional().nullable(),
  programme_requis: z.boolean().optional().default(false),
  est_favori: z.boolean().optional().default(false),
  ordre_affichage: z.coerce.number().int().min(0).max(9999).optional().default(100),
});
export type CreateFamilyBodyDTO = z.infer<typeof createFamilySchema>;

export const updateFamilySchema = z
  .object({
    libelle: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    programme_requis: z.boolean().optional(),
    est_favori: z.boolean().optional(),
    ordre_affichage: z.coerce.number().int().min(0).max(9999).optional(),
    actif: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Aucune modification fournie." });
export type UpdateFamilyBodyDTO = z.infer<typeof updateFamilySchema>;

/* -------------------------------------------------------------------------- */
/* Centres de frais                                                           */
/* -------------------------------------------------------------------------- */

export const listCostCentersQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  statut: z.enum(COST_CENTER_STATUSES).optional(),
  machine_family_code: familyCode.optional(),
  include_archived: booleanish.optional().default(false),
});

export const cfIdParamSchema = z.object({ cfId: uuid });

const costCenterCore = {
  designation: z.string().trim().min(2, "Désignation requise").max(200),
  type_cf: z.string().trim().max(80).optional().nullable(),
  section: z.string().trim().max(80).optional().nullable(),
  machine_family_code: familyCode.optional().nullable(),
  statut: z.enum(COST_CENTER_STATUSES).optional(),
  devise: z.string().trim().length(3, "Code devise ISO sur 3 lettres").toUpperCase().optional(),
  designation_auto: z.boolean().optional(),
  designation_modele: z.string().trim().max(300).optional().nullable(),
  commentaire: z.string().trim().max(2000).optional().nullable(),
};

export const createCostCenterSchema = z
  .object({
    code: z.string().trim().min(1, "Code requis").max(40),
    ...costCenterCore,
  })
  .refine((body) => !body.designation_auto || Boolean(body.designation_modele?.trim()), {
    message: "Une désignation automatique exige un modèle de désignation.",
    path: ["designation_modele"],
  });
export type CreateCostCenterBodyDTO = z.infer<typeof createCostCenterSchema>;

export const updateCostCenterSchema = z.object({
  code: z.string().trim().min(1).max(40).optional(),
  designation: z.string().trim().min(2).max(200).optional(),
  type_cf: z.string().trim().max(80).optional().nullable(),
  section: z.string().trim().max(80).optional().nullable(),
  machine_family_code: familyCode.optional().nullable(),
  statut: z.enum(COST_CENTER_STATUSES).optional(),
  devise: z.string().trim().length(3, "Code devise ISO sur 3 lettres").toUpperCase().optional(),
  designation_auto: z.boolean().optional(),
  designation_modele: z.string().trim().max(300).optional().nullable(),
  commentaire: z.string().trim().max(2000).optional().nullable(),
  // Verrou optimiste obligatoire : un référentiel se modifie à plusieurs.
  expected_updated_at: z.string().trim().min(1, "expected_updated_at est obligatoire"),
});
export type UpdateCostCenterBodyDTO = z.infer<typeof updateCostCenterSchema>;

export const addCostCenterRateSchema = z.object({
  // Un taux à 0 reste possible (poste non valorisé assumé) mais exige, comme
  // tout autre taux, une provenance écrite : ADR-0020 §6.
  taux_horaire: z.coerce.number().min(0, "Un taux horaire négatif n'existe pas").max(100_000),
  devise: z.string().trim().length(3).toUpperCase().optional(),
  date_effet: isoDate,
  source: z.string().trim().min(3, "La provenance du taux est obligatoire (au moins 3 caractères)").max(200),
  commentaire: z.string().trim().max(2000).optional().nullable(),
});
export type AddCostCenterRateBodyDTO = z.infer<typeof addCostCenterRateSchema>;

/* -------------------------------------------------------------------------- */
/* Machines                                                                   */
/* -------------------------------------------------------------------------- */

export const listMachineOptionsQuerySchema = z.object({
  machine_family_code: familyCode.optional(),
  search: z.string().trim().min(1).max(120).optional(),
  include_unselectable: booleanish.optional().default(true),
});

export const machineIdParamSchema = z.object({ machineId: uuid });

export const listMachinesQualificationQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  /** `true` = seulement les machines dont la famille n'est pas renseignée. */
  only_unqualified: booleanish.optional().default(false),
  include_archived: booleanish.optional().default(false),
});

export const previewMachineQualificationQuerySchema = z.object({
  machine_family_code: familyCode.optional(),
});

/**
 * Qualification d'une machine. `machine_family_code` et `cf_id` acceptent
 * explicitement `null` : « à qualifier » est une valeur assumée, pas un oubli.
 * Le `motif` est obligatoire — une affectation qui change le coût des gammes
 * futures se justifie par écrit.
 */
export const qualifyMachineSchema = z.object({
  machine_family_code: familyCode.nullable(),
  cf_id: uuid.nullable(),
  valid_from: isoDate.nullable().optional().default(null),
  valid_to: isoDate.nullable().optional().default(null),
  motif: z.string().trim().min(5, "Le motif de la qualification est obligatoire (au moins 5 caractères)").max(1000),
  expected_updated_at: z.string().trim().min(1, "expected_updated_at est obligatoire"),
});
export type QualifyMachineBodyDTO = z.infer<typeof qualifyMachineSchema>;

/* -------------------------------------------------------------------------- */
/* Fragments partagés avec le module Gammes                                   */
/* -------------------------------------------------------------------------- */

export const programNumberSchema = z.string().trim().max(PROGRAM_NUMBER_MAX_LENGTH).optional().nullable();

/**
 * Valide `body` / `params` / `query` et REMPLACE la valeur par la sortie du
 * schéma, pour que les coercitions (`booleanish`, majuscules) soient réellement
 * visibles par le contrôleur.
 */
export function validate(schema: z.ZodTypeAny, source: "body" | "params" | "query" = "body"): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      next(parsed.error);
      return;
    }
    // `req.query` est un getter en lecture seule sous Express 5 : on stocke la
    // version validée à côté plutôt que d'écraser la propriété d'origine.
    if (source === "query") {
      (req as unknown as { validatedQuery?: unknown }).validatedQuery = parsed.data;
    } else {
      req[source] = parsed.data as never;
    }
    next();
  };
}

export function validatedQuery<T>(req: unknown): T {
  return (req as { validatedQuery?: T }).validatedQuery as T;
}
