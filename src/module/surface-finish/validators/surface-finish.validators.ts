// #210 — Validation d'entrée de la bibliothèque de finitions et de la résolution
// d'article. Zod est la première ligne ; le domaine (`surface-finish-policy`) et
// la base restent les lignes suivantes. Aucune de ces trois n'est optionnelle.

import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

import { HttpError } from "../../../utils/httpError";
import {
  ARCHIVE_REASON_MIN_LENGTH,
  ARTICLE_DECISIONS,
  FINISH_SCOPES,
  SURFACE_FINISH_STATUSES,
  THICKNESS_UNITS,
} from "../domain/surface-finish-policy";

const uuid = z.string().uuid();
const shortText = z.string().trim().min(1).max(200);
const mediumText = z.string().trim().min(1).max(500);
const longText = z.string().trim().max(4000);

/** Une chaîne vide envoyée par un formulaire vaut « non renseigné », pas « chaîne vide ». */
const optionalText = (max = 200) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value === null || value === undefined) return null;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    })
    .refine((value) => value === null || value.length <= max, {
      message: `Ce champ ne peut pas dépasser ${max} caractères.`,
    });

const optionalNumber = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  })
  .refine((value) => value === null || value >= 0, { message: "Une valeur négative n'est pas acceptée." });

const tokenList = z
  .array(z.string().trim().min(1).max(120))
  .max(50, "50 entrées au maximum.")
  .optional()
  .transform((value) => value ?? []);

/**
 * Variante d'override : la distinction `undefined` (hériter de la révision) vs
 * `null` (effacer explicitement) doit SURVIVRE à la validation. Un `optionalText`
 * ordinaire écraserait l'absence en `null` et ferait disparaître les valeurs
 * héritées de la finition.
 */
const overrideText = (max = 200) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (value === null) return null;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    })
    .refine((value) => value === undefined || value === null || value.length <= max, {
      message: `Ce champ ne peut pas dépasser ${max} caractères.`,
    });

const overrideNumber = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  })
  .refine((value) => value === undefined || value === null || value >= 0, {
    message: "Une valeur négative n'est pas acceptée.",
  });

export const thicknessUnitSchema = z.enum(THICKNESS_UNITS);
export const finishScopeSchema = z.enum(FINISH_SCOPES);
export const finishStatusSchema = z.enum(SURFACE_FINISH_STATUSES);
export const articleDecisionSchema = z.enum(ARTICLE_DECISIONS);

/* -------------------------------------------------------------------------- */
/* Bibliothèque — recherche                                                    */
/* -------------------------------------------------------------------------- */

export const listFinishesQuerySchema = z.object({
  q: optionalText(120),
  family_code: optionalText(60),
  procede: optionalText(120),
  norme: optionalText(120),
  couleur: optionalText(120),
  epaisseur_um: optionalNumber,
  statut: z
    .union([finishStatusSchema, z.literal(""), z.null()])
    .optional()
    .transform((value) => (value ? (value as z.infer<typeof finishStatusSchema>) : null)),
  // Par défaut la recherche depuis une gamme ne propose que du sélectionnable.
  only_selectable: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .optional()
    .transform((value) => value === true || value === "true" || value === "1"),
  // #226 — Mes favoris. Personnel : jamais partagé entre utilisateurs.
  only_favorites: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .optional()
    .transform((value) => value === true || value === "true" || value === "1"),
  /**
   * #226 — Les archives sont EXCLUES par défaut. Une bibliothèque qui montre
   * ses archives sans qu'on les demande redevient illisible en un an.
   */
  include_archived: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .optional()
    .transform((value) => value === true || value === "true" || value === "1"),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  page_size: z.coerce.number().int().min(1).max(50).optional().default(20),
});
export type ListFinishesQueryDTO = z.infer<typeof listFinishesQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Bibliothèque — contrôle des doublons (#226)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Recherche de finitions proches AVANT création. Les mêmes champs que la
 * création, tous facultatifs : on interroge en cours de frappe, pas une fois le
 * formulaire complet.
 */
export const similarFinishesQuerySchema = z.object({
  family_code: optionalText(60),
  procede: optionalText(200),
  designation_courte: optionalText(200),
  synonymes: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (value === undefined) return [] as string[];
      const list = Array.isArray(value) ? value : value.split(",");
      return list.map((item) => item.trim()).filter((item) => item !== "").slice(0, 50);
    }),
  norme: optionalText(200),
  couleur: optionalText(120),
  epaisseur_um: optionalNumber,
  // Une modification exclut la finition en cours de sa propre liste de doublons.
  exclude_finish_id: z.union([uuid, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null)),
  limit: z.coerce.number().int().min(1).max(20).optional().default(8),
});
export type SimilarFinishesQueryDTO = z.infer<typeof similarFinishesQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Bibliothèque — archivage (#226)                                             */
/* -------------------------------------------------------------------------- */

export const archiveFinishBodySchema = z
  .object({
    // Sortir une entrée du référentiel se motive par écrit : c'est ce motif que
    // relira, dans deux ans, celui qui se demandera où est passée la finition.
    motif: z
      .string()
      .trim()
      .min(ARCHIVE_REASON_MIN_LENGTH, `Le motif doit faire au moins ${ARCHIVE_REASON_MIN_LENGTH} caractères.`)
      .max(1000),
    expected_updated_at: z.string().min(1),
  })
  .strict();
export type ArchiveFinishBodyDTO = z.infer<typeof archiveFinishBodySchema>;

export const reactivateFinishBodySchema = z
  .object({
    motif: z
      .string()
      .trim()
      .min(ARCHIVE_REASON_MIN_LENGTH, `Le motif doit faire au moins ${ARCHIVE_REASON_MIN_LENGTH} caractères.`)
      .max(1000),
    expected_updated_at: z.string().min(1),
  })
  .strict();
export type ReactivateFinishBodyDTO = z.infer<typeof reactivateFinishBodySchema>;

/* -------------------------------------------------------------------------- */
/* Bibliothèque — historique (#226)                                            */
/* -------------------------------------------------------------------------- */

export const finishHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  before_id: z.coerce.number().int().min(1).optional(),
});
export type FinishHistoryQueryDTO = z.infer<typeof finishHistoryQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Bibliothèque — écriture                                                     */
/* -------------------------------------------------------------------------- */

export const createFinishBodySchema = z.object({
  family_code: shortText,
  procede: shortText,
  designation_courte: shortText,
  designation_longue: optionalText(300),
  description: optionalText(2000),
  synonymes: tokenList,
});
export type CreateFinishBodyDTO = z.infer<typeof createFinishBodySchema>;

export const updateFinishBodySchema = z
  .object({
    family_code: shortText.optional(),
    procede: shortText.optional(),
    designation_courte: shortText.optional(),
    designation_longue: optionalText(300),
    description: optionalText(2000),
    synonymes: tokenList,
    expected_updated_at: z.string().min(1),
  })
  // `code` est délibérément absent : il est alloué par le serveur puis immuable.
  .strict();
export type UpdateFinishBodyDTO = z.infer<typeof updateFinishBodySchema>;

export const revisionPayloadSchema = z.object({
  norme: optionalText(200),
  reference_client: optionalText(200),
  classe: optionalText(120),
  substrat: optionalText(200),

  epaisseur_min: optionalNumber,
  epaisseur_nominale: optionalNumber,
  epaisseur_max: optionalNumber,
  epaisseur_unite: thicknessUnitSchema.optional().default("um"),

  couleur: optionalText(120),
  teinte_ral: optionalText(60),
  aspect: optionalText(120),
  brillance: optionalText(120),
  rugosite: optionalText(120),
  durete: optionalText(120),
  exigence_corrosion: optionalText(200),

  pretraitement: optionalText(300),
  posttraitement: optionalText(300),
  zones_defaut: tokenList,
  regles_masquage: tokenList,

  criteres_acceptation: longText.optional().transform((value) => (value ? value : null)),
  controles: tokenList,
  certificat_requis: z.boolean().optional().default(false),
  certificat_type: optionalText(120),
  conditionnement_retour: optionalText(300),
  unite_achat: optionalText(20),

  designation_template: optionalText(400),
  commentaire_template: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value === null || value === undefined) return null;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    })
    .refine((value) => value === null || value.length <= 4000, {
      message: "Le modèle de commentaire ne peut pas dépasser 4000 caractères.",
    }),

  date_effet: z
    .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
    .optional()
    .transform((value) => value ?? null),
});
export type RevisionPayloadDTO = z.infer<typeof revisionPayloadSchema>;

export const createRevisionBodySchema = revisionPayloadSchema;

export const updateRevisionBodySchema = revisionPayloadSchema.extend({
  expected_updated_at: z.string().min(1),
});
export type UpdateRevisionBodyDTO = z.infer<typeof updateRevisionBodySchema>;

export const transitionRevisionBodySchema = z.object({
  statut: finishStatusSchema,
  motif: optionalText(500),
  expected_updated_at: z.string().min(1),
});
export type TransitionRevisionBodyDTO = z.infer<typeof transitionRevisionBodySchema>;

export const attachDocumentBodySchema = z
  .object({
    libelle: mediumText,
    doc_type: z
      .enum(["SPECIFICATION", "NORME", "FICHE_TECHNIQUE", "PLAN_MASQUAGE", "CERTIFICAT_TYPE", "AUTRE"])
      .optional()
      .default("SPECIFICATION"),
    ged_document_id: z.union([uuid, z.null()]).optional().transform((v) => v ?? null),
    reference_externe: optionalText(300),
    sha256: z
      .union([z.string().regex(/^[0-9a-f]{64}$/), z.null()])
      .optional()
      .transform((v) => v ?? null),
  })
  .refine((body) => Boolean(body.ged_document_id) || Boolean(body.reference_externe), {
    message: "Un document exige une ancre : identifiant GED ou référence externe.",
    path: ["ged_document_id"],
  });
export type AttachDocumentBodyDTO = z.infer<typeof attachDocumentBodySchema>;

/* -------------------------------------------------------------------------- */
/* Configuration d'opération — aperçu et confirmation                          */
/* -------------------------------------------------------------------------- */

export const operationFinishParamsSchema = z.object({
  gammeId: uuid,
  operationId: uuid,
});

/** Overrides posés au niveau de l'opération. Chaque champ absent hérite de la révision. */
export const operationOverridesSchema = z.object({
  perimetre: finishScopeSchema.optional().default("PIECE_ENTIERE"),
  zones: tokenList,
  masquages: tokenList,
  norme: overrideText(200),
  classe: overrideText(120),
  epaisseur_min: overrideNumber,
  epaisseur_nominale: overrideNumber,
  epaisseur_max: overrideNumber,
  epaisseur_unite: thicknessUnitSchema.optional(),
  couleur: overrideText(120),
  teinte_ral: overrideText(60),
  aspect: overrideText(120),
  rugosite: overrideText(120),
  durete: overrideText(120),
  exigence_corrosion: overrideText(200),
  pretraitement: overrideText(300),
  posttraitement: overrideText(300),
  controles: tokenList,
  certificat_requis: z.boolean().optional(),
  certificat_type: overrideText(120),
  conditionnement: overrideText(300),
  unite_achat: overrideText(20),
  specification_client: overrideText(200),
  specification_client_version: overrideText(60),
  instructions: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value === null || value === undefined) return null;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    })
    .refine((value) => value === null || value.length <= 2000, {
      message: "Les instructions ne peuvent pas dépasser 2000 caractères.",
    }),
});
export type OperationOverridesDTO = z.infer<typeof operationOverridesSchema>;

export const previewFinishBodySchema = z.object({
  finish_revision_id: uuid,
  overrides: operationOverridesSchema.optional().default(operationOverridesSchema.parse({})),
  quantite: z.coerce.number().positive().max(1_000_000).optional().default(1),
});
export type PreviewFinishBodyDTO = z.infer<typeof previewFinishBodySchema>;

export const confirmFinishBodySchema = z.object({
  finish_revision_id: uuid,
  overrides: operationOverridesSchema.optional().default(operationOverridesSchema.parse({})),
  quantite: z.coerce.number().positive().max(1_000_000).optional().default(1),
  decision: articleDecisionSchema,
  article_id: z.union([uuid, z.null()]).optional().transform((v) => v ?? null),
  justification: optionalText(1000),
  preview_hash: z.string().regex(/^[0-9a-f]{64}$/, "Aperçu invalide."),
  spec_fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "Empreinte invalide."),
  expected_gamme_updated_at: z.string().min(1),
  expected_operation_updated_at: z.union([z.string().min(1), z.null()]).optional().transform((v) => v ?? null),
  expected_finition_updated_at: z.union([z.string().min(1), z.null()]).optional().transform((v) => v ?? null),
});
export type ConfirmFinishBodyDTO = z.infer<typeof confirmFinishBodySchema>;

/**
 * Depuis Stock, la PT et sa version sont explicites. Depuis une nomenclature
 * de PT, elles restent dérivées du contexte de gamme et ne sont jamais
 * redemandées : les deux routes conservent donc des contrats séparés.
 */
export const stockArticleFinishPreviewBodySchema = z.object({
  piece_technique_id: uuid,
  piece_technique_version_id: uuid,
  finish_revision_id: uuid,
  overrides: operationOverridesSchema.optional().default(operationOverridesSchema.parse({})),
});
export type StockArticleFinishPreviewBodyDTO = z.infer<typeof stockArticleFinishPreviewBodySchema>;

export const stockArticleFinishConfirmBodySchema = stockArticleFinishPreviewBodySchema.extend({
  decision: articleDecisionSchema,
  article_id: z.union([uuid, z.null()]).optional().transform((value) => value ?? null),
  justification: optionalText(1000),
  preview_hash: z.string().regex(/^[0-9a-f]{64}$/, "Aperçu invalide."),
  spec_fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "Empreinte invalide."),
});
export type StockArticleFinishConfirmBodyDTO = z.infer<typeof stockArticleFinishConfirmBodySchema>;

export const detachFinishBodySchema = z.object({
  motif: mediumText,
  expected_updated_at: z.string().min(1),
});
export type DetachFinishBodyDTO = z.infer<typeof detachFinishBodySchema>;

/* -------------------------------------------------------------------------- */
/* Middleware de validation                                                    */
/* -------------------------------------------------------------------------- */

type Target = "body" | "query" | "params";

/**
 * Valide et REMPLACE la section correspondante par la valeur normalisée : les
 * couches suivantes ne voient jamais l'entrée brute.
 */
export function validate(schema: z.ZodTypeAny, target: Target = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const source = target === "body" ? req.body : target === "query" ? req.query : req.params;
    const parsed = schema.safeParse(source);
    if (!parsed.success) {
      next(
        new HttpError(422, "VALIDATION_ERROR", "Données invalides.", {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
            code: issue.code,
          })),
        })
      );
      return;
    }
    if (target === "body") req.body = parsed.data;
    else if (target === "query") Object.assign(req.query as object, parsed.data);
    else req.params = parsed.data as typeof req.params;
    next();
  };
}
