import { z } from "zod";
import { MARGIN_BASES, MARGIN_COST_CATEGORIES } from "../domain/margin-engine";

export const marginScopeTypeSchema = z.enum(["DEVIS_LINE", "DEVIS", "AFFAIRE", "OF"]);
export const marginBasisSchema = z.enum(MARGIN_BASES);
export const marginScopeParamsSchema = z.object({
  scopeType: z.enum(["devis-line", "devis", "affaire", "of"]),
  scopeRef: z.string().regex(/^\d+$/, "Identifiant numérique attendu."),
});
export const marginReadQuerySchema = z.object({
  as_of: z.string().date().optional(),
});
export const marginSnapshotBodySchema = z.object({ basis: marginBasisSchema });
export const marginSnapshotListQuerySchema = z.object({
  basis: marginBasisSchema.optional(),
  as_of: z.string().date().optional(),
});

const availabilitySchema = z.enum(["PROVIDED", "NOT_APPLICABLE"]);
const amountSchema = z.coerce.number().finite().nonnegative().transform(String);

export const createMarginInputSchema = z.object({
  scope_type: marginScopeTypeSchema,
  scope_ref: z.string().regex(/^\d+$/),
  basis: marginBasisSchema,
  input_key: z.string().trim().min(1).max(120),
  input_kind: z.enum(["REVENUE", "COST"]),
  category: z.enum(MARGIN_COST_CATEGORIES).nullable().optional(),
  availability: availabilitySchema,
  amount_ht: amountSchema.nullable().optional(),
  quantity: amountSchema.nullable().optional(),
  rate_id: z.string().uuid().nullable().optional(),
  rate_effective_at: z.string().date().nullable().optional(),
  source_type: z.string().trim().min(1).max(80),
  source_ref: z.string().trim().max(200).nullable().optional(),
  observed_at: z.string().datetime({ offset: true }).nullable().optional(),
  definition: z.string().trim().min(1).max(500),
  unit: z.string().trim().min(1).max(80),
  period_start: z.string().date(),
  period_end: z.string().date(),
  source_reliability: z.enum(["ESTIMATED", "DECLARED", "VERIFIED"]),
  source_document_type: z.string().trim().min(1).max(80).nullable().optional(),
  source_document_ref: z.string().trim().min(1).max(200).nullable().optional(),
  assumption: z.string().trim().min(1).max(1000).nullable().optional(),
  assumption_date: z.string().date().nullable().optional(),
  supersedes_id: z.string().uuid().nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.period_end < value.period_start) {
    ctx.addIssue({ code: "custom", path: ["period_end"], message: "La fin de période doit suivre son début." });
  }
  if (value.source_reliability === "VERIFIED" && value.observed_at == null) {
    ctx.addIssue({ code: "custom", path: ["observed_at"], message: "Une source vérifiée doit être datée." });
  }
  if (value.source_reliability === "VERIFIED" && (value.source_document_type == null || value.source_document_ref == null)) {
    ctx.addIssue({ code: "custom", path: ["source_document_ref"], message: "Une source vérifiée doit référencer son document métier." });
  }
  if ((value.input_kind === "REVENUE") !== (value.category == null)) {
    ctx.addIssue({ code: "custom", path: ["category"], message: "La catégorie est requise uniquement pour un coût." });
  }
  if (value.availability === "NOT_APPLICABLE" && (value.amount_ht != null || value.quantity != null || value.rate_id != null || value.rate_effective_at != null)) {
    ctx.addIssue({ code: "custom", path: ["availability"], message: "NOT_APPLICABLE ne porte aucune valeur." });
  }
  if (value.availability === "PROVIDED" && ((value.amount_ht == null) === (value.rate_id == null))) {
    ctx.addIssue({ code: "custom", path: ["amount_ht"], message: "Fournir exactement un montant ou un taux versionné." });
  }
  if ((value.rate_id == null) !== (value.rate_effective_at == null)) {
    ctx.addIssue({ code: "custom", path: ["rate_effective_at"], message: "Tout taux doit porter sa date d'application." });
  }
  if (value.amount_ht != null && value.quantity != null) {
    ctx.addIssue({ code: "custom", path: ["quantity"], message: "Une quantité ne s'applique qu'à un taux versionné." });
  }
  if ((value.assumption == null) !== (value.assumption_date == null)) {
    ctx.addIssue({ code: "custom", path: ["assumption_date"], message: "Toute hypothèse doit être datée." });
  }
});

export const createRateVersionSchema = z.object({
  code: z.string().trim().min(1).max(80),
  version: z.number().int().positive(),
  effective_from: z.string().date(),
  effective_to: z.string().date().nullable().optional(),
  source: z.string().trim().min(1).max(500),
  source_reliability: z.enum(["ESTIMATED", "DECLARED", "VERIFIED"]),
  assumption_date: z.string().date(),
  notes: z.string().trim().max(2000).nullable().optional(),
  supersedes_id: z.string().uuid().nullable().optional(),
  rates: z.array(z.object({
    rate_code: z.string().trim().min(1).max(80),
    category: z.enum(MARGIN_COST_CATEGORIES),
    scope_type: z.enum(["GLOBAL", "USER", "MACHINE", "COST_CENTER", "PIECE_TECHNIQUE"]),
    scope_ref: z.string().trim().min(1).max(200).nullable().optional(),
    amount: amountSchema,
    unit: z.enum(["EUR_PER_HOUR", "EUR_PER_UNIT", "PERCENT_OF_DIRECT_COST"]),
    source_ref: z.string().trim().max(500).nullable().optional(),
  })).min(1).max(100),
}).superRefine((value, ctx) => {
  if (value.effective_to && value.effective_to < value.effective_from) {
    ctx.addIssue({ code: "custom", path: ["effective_to"], message: "La date de fin doit suivre la date d'effet." });
  }
  value.rates.forEach((rate, index) => {
    if ((rate.scope_type === "GLOBAL") !== (rate.scope_ref == null)) {
      ctx.addIssue({ code: "custom", path: ["rates", index, "scope_ref"], message: "GLOBAL n'a pas de référence; les autres portées en exigent une." });
    }
    const unitMatches = rate.unit === "PERCENT_OF_DIRECT_COST"
      ? rate.category === "OVERHEAD"
      : rate.unit === "EUR_PER_HOUR"
        ? ["MACHINE", "OPERATOR", "CONTROL"].includes(rate.category)
        : !["OVERHEAD", "OPERATOR", "CONTROL"].includes(rate.category);
    if (!unitMatches) {
      ctx.addIssue({ code: "custom", path: ["rates", index, "unit"], message: "L'unité n'est pas compatible avec la catégorie de coût." });
    }
  });
});

export type CreateMarginInput = z.infer<typeof createMarginInputSchema>;
export type CreateRateVersion = z.infer<typeof createRateVersionSchema>;
