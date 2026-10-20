import { z } from "zod";
import { CUTOVER_DOMAINS } from "../types/data-cutover.types";
import { catalogFor } from "../domain/cutover-catalog";

const scalar = z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.null()]);
export const cutoverValuesSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine((key) => !["constructor", "prototype", "__proto__"].includes(key)), scalar).refine((values) => Object.keys(values).length <= 60, "Trop de champs dans la fiche.");
const source = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/),
  name: z.string().trim().min(1).max(240).refine((name) => !/[\\/\u0000-\u001f]/.test(name), "Un nom de fichier simple est attendu, sans chemin."),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot_at: z.string().datetime({ offset: true }),
}).strict();
export const cutoverSourceRowSchema = z.object({
  domain: z.enum(CUTOVER_DOMAINS), legacy_key: z.string().trim().min(1).max(300),
  source_id: source.shape.id, sheet: z.string().max(100), row_number: z.number().int().min(1).max(1_048_576),
  values: cutoverValuesSchema, source_issues: z.array(z.string().max(1000)).max(30).optional().default([]), source_notes: z.array(z.string().max(1000)).max(30).optional().default([]),
}).strict();
export const createCutoverBatchSchema = z.object({
  name: z.string().trim().min(3).max(160), source_system: z.literal("CLIPPER_EXCEL"),
  sources: z.array(source).min(1).max(200), rows: z.array(cutoverSourceRowSchema).min(1).max(20_000),
}).strict().superRefine((body, ctx) => {
  const sources = new Set(body.sources.map((item) => item.id));
  if (sources.size !== body.sources.length) ctx.addIssue({ code: "custom", path: ["sources"], message: "Identifiants de sources dupliqués." });
  const keys = new Set<string>();
  body.rows.forEach((row, index) => {
    const fields = new Set(catalogFor(row.domain).fields.map((field) => field.key));
    for (const field of Object.keys(row.values)) if (!fields.has(field)) ctx.addIssue({ code: "custom", path: ["rows", index, "values", field], message: "Champ non prévu pour ce domaine. Préparer un dossier limité aux données nécessaires." });
    if (!sources.has(row.source_id)) ctx.addIssue({ code: "custom", path: ["rows", index, "source_id"], message: "Source inconnue." });
    const key = `${row.domain}\u0000${row.legacy_key}`;
    if (keys.has(key)) ctx.addIssue({ code: "custom", path: ["rows", index, "legacy_key"], message: "Clé d'origine dupliquée dans ce domaine." });
    keys.add(key);
  });
});
export type CreateCutoverBatch = z.infer<typeof createCutoverBatchSchema>;
export const patchCutoverRowSchema = z.object({ expected_version: z.number().int().positive(), values: cutoverValuesSchema, decision: z.enum(["PENDING", "INCLUDE", "EXCLUDE"]), review_note: z.string().trim().max(4000).nullish().transform((value) => value ?? "") }).strict();
export type PatchCutoverRow = z.infer<typeof patchCutoverRowSchema>;
export const previewCutoverSchema = z.object({ expected_version: z.number().int().positive(), cutoff_at: z.string().datetime({ offset: true }).optional() }).strict();
export const validateCutoverSchema = z.object({
  expected_version: z.number().int().positive(), expected_preview_hash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true),
  checklist: z.object({ sources_frozen: z.boolean().optional(), physical_stock_verified: z.boolean().optional(), wip_verified: z.boolean().optional(), accounting_reconciled: z.boolean().optional(), exclusive_scope: z.boolean().optional(), no_external_emissions: z.boolean().optional() }).strict(),
  reviewer_name: z.string().trim().min(2).max(120), review_note: z.string().trim().min(5).max(4000),
}).strict();
export type ValidateCutover = z.infer<typeof validateCutoverSchema>;
export const listCutoverRowsSchema = z.object({ domain: z.enum(CUTOVER_DOMAINS).optional(), status: z.enum(["UNDECIDED", "MISSING", "READY", "EXCLUDED"]).optional(), search: z.string().trim().max(150).optional(), page: z.coerce.number().int().min(1).max(10000).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25) }).strict();
export const cutoverUuid = z.string().uuid();
export const cutoverIdempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{8,200}$/);
export const applicationPreviewSchema = z.object({ expected_version: z.number().int().positive() }).strict();
export const prepareWipDeliveryTargetSchema = z.object({
  expected_version: z.number().int().positive(),
  commande_ligne_id: z.string().regex(/^[1-9]\d{0,14}$/, "Sélectionner une ligne de commande CERP valide."),
}).strict();
export const applicationApplySchema = z.object({
  expected_version: z.number().int().positive(),
  expected_preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
  checkpoint: z.object({
    backup_reference: z.string().trim().min(5).max(500),
    scope_stopped: z.literal(true),
    signoffs_complete: z.literal(true),
    no_external_emissions: z.literal(true),
  }).strict(),
}).strict();
export type ApplicationApplyInput = z.infer<typeof applicationApplySchema>;
