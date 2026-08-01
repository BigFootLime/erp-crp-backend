import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD");
const year = z.coerce.number().int().min(2000).max(2200);
const safeIdentifier = (label: string, min: number, max: number) =>
  z.string().trim().min(min).max(max).regex(/^[A-Za-z0-9._/-]+$/, `${label} ne peut contenir que lettres, chiffres, ., _, / et -.`);

const sequenceSchema = z
  .object({
    year,
    prefix: safeIdentifier("Le préfixe", 1, 60),
    next_value: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    padding: z.coerce.number().int().min(1).max(12),
  })
  .strict();

export const financeConfigurationReadinessQuerySchema = z
  .object({ year: year.optional() })
  .strict();

export type FinanceConfigurationReadinessQueryDTO = z.infer<
  typeof financeConfigurationReadinessQuerySchema
>;

export const activateFinanceConfigurationBodySchema = z
  .object({
    confirm: z.literal(true),
    legal_entity_code: z.string().uuid(),
    policy_version: safeIdentifier("La version de politique", 3, 80),
    effective_from: isoDate,
    effective_to: isoDate.optional().nullable(),
    eligible_delivery_statuses: z
      .array(z.enum(["SHIPPED", "DELIVERED"]))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length, "Statuts dupliqués interdits."),
    // Historical column name retained: this controls creator/validator separation of duties.
    require_distinct_issuer: z.boolean().default(true),
    sequences: z
      .object({
        facture: sequenceSchema,
        avoir: sequenceSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.effective_to && value.effective_to < value.effective_from) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effective_to"],
        message: "La date de fin doit être postérieure ou égale à la date de début.",
      });
    }
  });

export type ActivateFinanceConfigurationBodyDTO = z.infer<
  typeof activateFinanceConfigurationBodySchema
>;

export const createFinanceSequencesBodySchema = z
  .object({
    confirm: z.literal(true),
    sequences: z.object({ facture: sequenceSchema.optional(), avoir: sequenceSchema.optional() }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.sequences.facture && !value.sequences.avoir) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sequences"], message: "Au moins une séquence est requise." });
    }
  });

export type CreateFinanceSequencesBodyDTO = z.infer<typeof createFinanceSequencesBodySchema>;
