import { z } from "zod";
import { MARGIN_COST_CATEGORIES } from "../domain/margin-engine";

export const marginScopeTypeSchema = z.enum(["DEVIS_LINE", "DEVIS", "AFFAIRE", "OF"]);
export const marginBasisSchema = z.enum(["PLANNED", "ACTUAL"]);
export const marginScopeParamsSchema = z.object({
  scopeType: z.enum(["devis-line", "devis", "affaire", "of"]),
  scopeRef: z.string().regex(/^\d+$/, "Identifiant numérique attendu."),
});
export const marginReadQuerySchema = z.object({
  as_of: z.string().date().optional(),
});
export const marginSnapshotBodySchema = z.object({ basis: marginBasisSchema });

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
  source_type: z.string().trim().min(1).max(80),
  source_ref: z.string().trim().max(200).nullable().optional(),
  observed_at: z.string().datetime({ offset: true }).nullable().optional(),
  assumption: z.string().trim().min(1).max(1000).nullable().optional(),
  assumption_date: z.string().date().nullable().optional(),
  supersedes_id: z.string().uuid().nullable().optional(),
}).superRefine((value, ctx) => {
  if ((value.input_kind === "REVENUE") !== (value.category == null)) {
    ctx.addIssue({ code: "custom", path: ["category"], message: "La catégorie est requise uniquement pour un coût." });
  }
  if (value.availability === "NOT_APPLICABLE" && (value.amount_ht != null || value.quantity != null || value.rate_id != null)) {
    ctx.addIssue({ code: "custom", path: ["availability"], message: "NOT_APPLICABLE ne porte aucune valeur." });
  }
  if (value.availability === "PROVIDED" && value.amount_ht == null && value.rate_id == null) {
    ctx.addIssue({ code: "custom", path: ["amount_ht"], message: "Un montant ou un taux versionné est requis." });
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
  value.rates.forEach((rate, index) => {
    if ((rate.scope_type === "GLOBAL") !== (rate.scope_ref == null)) {
      ctx.addIssue({ code: "custom", path: ["rates", index, "scope_ref"], message: "GLOBAL n'a pas de référence; les autres portées en exigent une." });
    }
  });
});

export type CreateMarginInput = z.infer<typeof createMarginInputSchema>;
export type CreateRateVersion = z.infer<typeof createRateVersionSchema>;
