import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD");
const decimal = (maxDecimals: number, label: string) =>
  z
    .string()
    .trim()
    .regex(
      new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${maxDecimals}})?$`),
      `${label} doit être un nombre décimal positif avec au plus ${maxDecimals} décimales`
    );

export const financeUuidParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const financeLegacyIdParamsSchema = z
  .object({
    id: z.coerce.number().int().positive(),
  })
  .strict();

export const eligibleSourcesQuerySchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    client_id: z.string().trim().min(1).max(120).optional(),
    commande_id: z.coerce.number().int().positive().optional(),
    affaire_id: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

export type EligibleSourcesQueryDTO = z.infer<typeof eligibleSourcesQuerySchema>;

const sourceSelectionSchema = z
  .object({
    source_type: z.enum(["DELIVERY_LINE", "MILESTONE", "DEPOSIT"]),
    source_id: z.string().trim().min(1).max(200),
    source_line_id: z.string().trim().min(1).max(200),
    quantity: decimal(3, "Quantité"),
  })
  .strict();

const dueDateSchema = z
  .object({
    due_date: isoDate,
    amount: decimal(2, "Montant d'échéance").optional(),
    label: z.string().trim().min(1).max(120),
  })
  .strict();

export const facturePreviewBodySchema = z
  .object({
    client_id: z.string().trim().min(1).max(120),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("EUR"),
    sources: z.array(sourceSelectionSchema).min(1).max(200),
    global_discount_percent: decimal(4, "Remise globale").default("0"),
    due_dates: z.array(dueDateSchema).min(1).max(24),
    internal_comment: z.string().trim().max(4000).optional().nullable(),
    customer_text: z.string().trim().max(4000).optional().nullable(),
  })
  .strict();

export type FacturePreviewBodyDTO = z.infer<typeof facturePreviewBodySchema>;

export const createFactureDraftBodySchema = facturePreviewBodySchema
  .extend({
    preview_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

export type CreateFactureDraftBodyDTO = z.infer<typeof createFactureDraftBodySchema>;

export const workflowConfirmationBodySchema = z
  .object({
    expected_version: z.coerce.number().int().positive(),
    preview_hash: z.string().regex(/^[a-f0-9]{64}$/i),
    confirm: z.literal(true),
  })
  .strict();

export type WorkflowConfirmationBodyDTO = z.infer<typeof workflowConfirmationBodySchema>;

export const validationDecisionBodySchema = z
  .object({
    expected_version: z.coerce.number().int().positive(),
    decision: z.enum(["APPROVE", "RETURN"]),
    reason: z.string().trim().min(3).max(2000).optional().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "RETURN" && !value.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Un motif est requis pour retourner le brouillon.",
      });
    }
  });

export type ValidationDecisionBodyDTO = z.infer<typeof validationDecisionBodySchema>;

const avoirLineSelectionSchema = z
  .object({
    facture_line_id: z.coerce.number().int().positive(),
    quantity: decimal(3, "Quantité créditée"),
  })
  .strict();

export const avoirPreviewBodySchema = z
  .object({
    facture_id: z.coerce.number().int().positive(),
    reason_code: z.enum([
      "RETURN",
      "QUALITY",
      "PRICE_CORRECTION",
      "QUANTITY_CORRECTION",
      "COMMERCIAL_GESTURE",
      "OTHER",
    ]),
    reason: z.string().trim().min(3).max(2000),
    lines: z.array(avoirLineSelectionSchema).min(1).max(200),
  })
  .strict();

export type AvoirPreviewBodyDTO = z.infer<typeof avoirPreviewBodySchema>;

export const createAvoirDraftBodySchema = avoirPreviewBodySchema
  .extend({
    preview_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

export type CreateAvoirDraftBodyDTO = z.infer<typeof createAvoirDraftBodySchema>;

const paymentAllocationSchema = z
  .object({
    target_type: z.enum(["FACTURE", "ECHEANCE"]),
    target_id: z.string().trim().min(1).max(120),
    amount: decimal(2, "Montant alloué"),
    variance_reason: z.string().trim().min(3).max(500).optional().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (/^0(?:\.0+)?$/.test(value.amount)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "Le montant alloué doit être strictement positif.",
      });
    }
  });

export const registerPaymentBodySchema = z
  .object({
    client_id: z.string().trim().min(1).max(120),
    value_date: isoDate,
    booking_date: isoDate,
    amount: decimal(2, "Montant du paiement"),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("EUR"),
    mode: z.string().trim().min(1).max(80),
    reference: z.string().trim().min(1).max(200),
    proof_document_id: z.string().uuid().optional().nullable(),
    comment: z.string().trim().max(2000).optional().nullable(),
    allocations: z.array(paymentAllocationSchema).max(200).optional().default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (/^0(?:\.0+)?$/.test(value.amount)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "Le montant du paiement doit être strictement positif.",
      });
    }
    if (value.booking_date < value.value_date) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["booking_date"],
        message: "La date comptable ne peut pas précéder la date de valeur.",
      });
    }
  });

export type RegisterPaymentBodyDTO = z.infer<typeof registerPaymentBodySchema>;

export const allocatePaymentBodySchema = z
  .object({
    expected_version: z.coerce.number().int().positive(),
    allocations: z.array(paymentAllocationSchema).min(1).max(200),
  })
  .strict();

export type AllocatePaymentBodyDTO = z.infer<typeof allocatePaymentBodySchema>;
