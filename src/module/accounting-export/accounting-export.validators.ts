import { z } from "zod";

import { ACCOUNTING_EXPORT_ADAPTER, ACCOUNTING_SOURCE_TYPES } from "./accounting-export.domain";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD");
const safeCode = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._/-]+$/);
const accountNumber = z.string().trim().min(3).max(20).regex(/^[A-Za-z0-9]+$/);
const journalCode = z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9]+$/);
const taxRateKey = z.string().trim().regex(/^\d{1,3}(?:\.\d{1,4})?$/);
const taxCategoryRateKey = z.string().trim().regex(/^[A-Z]{1,3}:\d{1,3}(?:\.\d{1,4})?$/);

export const accountingMappingConfigSchema = z.object({
  delimiter: z.enum([";", ",", "\t"]),
  sales_journal: journalCode,
  credit_journal: journalCode,
  bank_journal_by_mode: z.record(z.string().trim().min(1).max(40), journalCode).default({}),
  bank_account_by_mode: z.record(z.string().trim().min(1).max(40), accountNumber).default({}),
  default_bank_journal: journalCode.nullable().default(null),
  default_bank_account: accountNumber.nullable().default(null),
  sales_account_by_tax: z.record(taxRateKey, accountNumber),
  vat_output_account_by_tax: z.record(taxRateKey, accountNumber),
  purchase_journal: journalCode.nullable().default(null),
  supplier_credit_journal: journalCode.nullable().default(null),
  purchase_account_by_tax_category: z.record(taxCategoryRateKey, accountNumber).default({}),
  vat_input_account_by_tax_category: z.record(taxCategoryRateKey, accountNumber).default({}),
  reverse_charge_output_account_by_tax_category: z.record(taxCategoryRateKey, accountNumber).default({}),
  self_assessed_vat_rate_by_tax_category: z.record(taxCategoryRateKey, taxRateKey).default({}),
  fx_gain_account: accountNumber.nullable().default(null),
  fx_loss_account: accountNumber.nullable().default(null),
  default_axes: z.record(safeCode, safeCode).default({}),
}).strict();

export const createAccountingMappingSchema = z.object({
  version_code: safeCode,
  adapter_code: z.literal(ACCOUNTING_EXPORT_ADAPTER),
  effective_from: isoDate,
  effective_to: isoDate.nullable().optional(),
  activate: z.boolean().default(false),
  config: accountingMappingConfigSchema,
}).strict().superRefine((value, context) => {
  if (value.effective_to && value.effective_to < value.effective_from) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["effective_to"], message: "La date de fin précède la date de début." });
  }
});

export const listAccountingMappingsSchema = z.object({
  include_retired: z.coerce.boolean().default(false),
}).strict();

export const createAccountingPreviewSchema = z.object({
  mapping_version_id: z.string().uuid(),
  period_from: isoDate,
  period_to: isoDate,
  source_types: z.array(z.enum(ACCOUNTING_SOURCE_TYPES)).min(1).max(5)
    .refine((values) => new Set(values).size === values.length, "Types source dupliqués."),
}).strict().superRefine((value, context) => {
  if (value.period_to < value.period_from) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["period_to"], message: "La date de fin précède la date de début." });
  }
});

export const accountingBatchIdSchema = z.string().uuid();
export const expectedBatchVersionSchema = z.object({ expected_version: z.coerce.number().int().positive() }).strict();
export const cancelAccountingBatchSchema = expectedBatchVersionSchema.extend({
  reason: z.string().trim().min(8).max(500),
}).strict();
export const reexportAccountingBatchSchema = z.object({
  mapping_version_id: z.string().uuid().optional(),
  reason: z.string().trim().min(8).max(500),
}).strict();

export type CreateAccountingMappingDTO = z.infer<typeof createAccountingMappingSchema>;
export type CreateAccountingPreviewDTO = z.infer<typeof createAccountingPreviewSchema>;
export type ExpectedBatchVersionDTO = z.infer<typeof expectedBatchVersionSchema>;
export type CancelAccountingBatchDTO = z.infer<typeof cancelAccountingBatchSchema>;
export type ReexportAccountingBatchDTO = z.infer<typeof reexportAccountingBatchSchema>;
