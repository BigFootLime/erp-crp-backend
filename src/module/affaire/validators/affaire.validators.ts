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
export type AffaireStatut = z.infer<typeof affaireStatutSchema>;
// livraison = affaire de livraison client (client requis) ; projet = regroupement interne (client optionnel)
export const affaireTypeSchema = z.enum(["livraison", "projet"]);
export const affaireCommandCenterSegmentSchema = z.enum([
  "active",
  "production",
  "control",
  "ready_delivery",
  "partial_delivered",
  "delivered",
  "to_invoice",
  "blocked",
  "late",
]);

// Jeton de verrou optimiste : le frontend renvoie la valeur `updated_at` reçue lors du
// dernier GET. Le serveur compare la représentation `::text` exacte (cf. commande V3
// `expected_updated_at`). Format libre volontairement : c'est un jeton d'égalité, pas une date.
const optimisticToken = z.preprocess(emptyStringToUndefined, z.string().trim().min(1)).optional();

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

export const listAffairesCommandCenterQuerySchema = listAffairesQuerySchema.extend({
  segment: affaireCommandCenterSegmentSchema.optional(),
});

export type ListAffairesCommandCenterQueryDTO = z.infer<typeof listAffairesCommandCenterQuerySchema>;

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

// Création : le `statut` initial n'est pas librement posé (machine d'état = transitions
// dédiées) ; le code `reference` est TOUJOURS attribué par le serveur (AFF-AAAA-NNNN) et
// n'est jamais accepté depuis le client. Toute clé `reference` reçue est silencieusement ignorée.
export const createAffaireBodySchema = z
  .object({
    client_id: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
    commande_id: z.coerce.number().int().positive().optional().nullable(),
    devis_id: z.coerce.number().int().positive().optional().nullable(),
    type_affaire: affaireTypeSchema.optional().default("livraison"),
    date_ouverture: z.preprocess(emptyStringToUndefined, isoDate).optional(),
    commentaire: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    // Client requis pour une affaire de livraison, optionnel pour un projet.
    const isProjet = value.type_affaire === "projet";
    const hasClient = typeof value.client_id === "string" && value.client_id.trim().length > 0;
    if (!isProjet && !hasClient) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "client_id is required for livraison", path: ["client_id"] });
    }
  });

export type CreateAffaireBodyDTO = z.infer<typeof createAffaireBodySchema>;

// Aperçu de création manuelle : mêmes champs métier que la création, sans clé d'idempotence
// (aucun effet de bord). Le serveur renvoie code/version attendue/avertissements/bloqueurs.
export const previewAffaireBodySchema = z
  .object({
    client_id: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
    commande_id: z.coerce.number().int().positive().optional().nullable(),
    devis_id: z.coerce.number().int().positive().optional().nullable(),
    type_affaire: affaireTypeSchema.optional().default("livraison"),
    commentaire: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    const isProjet = value.type_affaire === "projet";
    const hasClient = typeof value.client_id === "string" && value.client_id.trim().length > 0;
    if (!isProjet && !hasClient) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "client_id is required for livraison", path: ["client_id"] });
    }
  });

export type PreviewAffaireBodyDTO = z.infer<typeof previewAffaireBodySchema>;

// PATCH générique = métadonnées seulement. Le `statut` (machine d'état) et la `reference`
// (code serveur immuable) sont volontairement absents : ils passent par /transition et ne
// sont jamais modifiables. `expected_updated_at` porte le verrou optimiste.
export const updateAffaireBodySchema = z.object({
  client_id: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  commande_id: z.coerce.number().int().positive().optional().nullable(),
  devis_id: z.coerce.number().int().positive().optional().nullable(),
  type_affaire: affaireTypeSchema.optional(),
  date_ouverture: z.preprocess(emptyStringToUndefined, isoDate).optional(),
  commentaire: z.preprocess(emptyStringToNull, z.string().trim().min(1)).optional().nullable(),
  expected_updated_at: optimisticToken,
});

export type UpdateAffaireBodyDTO = z.infer<typeof updateAffaireBodySchema>;

// Transition d'état serveur. `to` = statut cible ; `reason` = motif audité (obligatoire pour
// suspension/annulation/réouverture) ; `expected_updated_at` = verrou optimiste.
export const transitionAffaireBodySchema = z
  .object({
    to: affaireStatutSchema,
    reason: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(500)).optional().nullable(),
    date_cloture: z.preprocess(emptyStringToNull, isoDate).optional().nullable(),
    expected_updated_at: optimisticToken,
  })
  .superRefine((value, ctx) => {
    const reasonRequired = value.to === "SUSPENDUE" || value.to === "ANNULEE";
    const hasReason = typeof value.reason === "string" && value.reason.trim().length > 0;
    if (reasonRequired && !hasReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `reason is required to transition to ${value.to}`,
        path: ["reason"],
      });
    }
  });

export type TransitionAffaireBodyDTO = z.infer<typeof transitionAffaireBodySchema>;

// Archivage : aucune suppression physique. `reason` audité, verrou optimiste facultatif.
export const archiveAffaireBodySchema = z.object({
  reason: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(500)).optional().nullable(),
  expected_updated_at: optimisticToken,
});

export type ArchiveAffaireBodyDTO = z.infer<typeof archiveAffaireBodySchema>;
