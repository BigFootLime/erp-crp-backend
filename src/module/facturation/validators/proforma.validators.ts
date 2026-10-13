import { z } from "zod";

const positiveQuantity = z.string().trim().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/)
  .refine(value => !/^0(?:\.0+)?$/.test(value), "La quantité doit être positive.");
const positiveMoney = z.string().trim().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  .refine(value => !/^0(?:\.0+)?$/.test(value), "Le montant doit être positif.");
const selectedClient = z.string().trim().min(1).max(120);

const billingPartSchema = z.object({
  billed_client_id: selectedClient,
  quantity: positiveQuantity,
}).strict();

const proformaAffairSelectionSchema = z.object({
  allocation_id: z.number().int().positive().safe(),
  billing_parts: z.array(billingPartSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const clients = value.billing_parts.map(part => part.billed_client_id);
  if (new Set(clients).size !== clients.length) ctx.addIssue({ code: z.ZodIssueCode.custom,
    path: ["billing_parts"], message: "Sélectionnez chaque société facturée une seule fois." });
});

// Prices, tax, status and source snapshots are resolved server-side from the order.
const selectionBodySchema = z.object({
  client_id: selectedClient,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("EUR"),
  affairs: z.array(proformaAffairSelectionSchema).min(1).max(200),
}).strict();
function validateAffairSelection(value: z.infer<typeof selectionBodySchema>, ctx: z.RefinementCtx) {
  const ids = value.affairs.map(affair => affair.allocation_id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom,
    path: ["affairs"], message: "Une affaire ne peut être sélectionnée qu'une fois." });
  if (value.affairs.reduce((sum, affair) => sum + affair.billing_parts.length, 0) > 200) ctx.addIssue({
    code: z.ZodIssueCode.custom, path: ["affairs"], message: "Une proforma peut contenir au maximum 200 répartitions d'articles." });
}
export const proformaDraftBodySchema = selectionBodySchema.superRefine(validateAffairSelection);

export type ProformaDraftBodyDTO = z.infer<typeof proformaDraftBodySchema>;

export const proformaCreateBodySchema = selectionBodySchema.extend({
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/i),
}).superRefine(validateAffairSelection);
export type ProformaCreateBodyDTO = z.infer<typeof proformaCreateBodySchema>;

export const proformaListQuerySchema = z.object({
  q: z.string().trim().max(160).optional().default(""),
  client_id: selectedClient.optional(),
  status: z.enum(["DRAFT", "ISSUED", "CANCELLED"]).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
}).strict();
export type ProformaListQueryDTO = z.infer<typeof proformaListQuerySchema>;

export const proformaIdParamsSchema = z.object({ id: z.string().uuid() }).strict();
export const proformaAllocationParamsSchema = z.object({ allocationId: z.coerce.number().int().positive().safe() }).strict();

export const proformaIssueBodySchema = z.object({
  expected_version: z.number().int().positive().safe(),
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  confirm: z.literal(true),
}).strict();

export type ProformaIssueBodyDTO = z.infer<typeof proformaIssueBodySchema>;

export const proformaReceiptAssignmentBodySchema = z.object({
  payment_allocation_id: z.string().uuid(),
  assignments: z.array(z.object({
    proforma_billing_part_id: z.string().uuid(),
    deposit_source_id: z.string().uuid(),
    amount: positiveMoney,
  }).strict()).min(1).max(200),
}).strict().superRefine((value, ctx) => {
  const targets = value.assignments.map(row => `${row.proforma_billing_part_id}:${row.deposit_source_id}`);
  if (new Set(targets).size !== targets.length) ctx.addIssue({ code: z.ZodIssueCode.custom,
    path: ["assignments"], message: "Une cible ne peut recevoir qu'une affectation par action." });
});

export type ProformaReceiptAssignmentBodyDTO = z.infer<typeof proformaReceiptAssignmentBodySchema>;

export const deliveryPrepaymentTermsBodySchema = z.object({
  expected_version: z.number().int().nonnegative().safe(),
  requirement: z.enum(["NOT_REQUIRED", "PROFORMA"]),
  reason: z.string().trim().min(3).max(1000),
  confirm: z.literal(true),
}).strict();

export type DeliveryPrepaymentTermsBodyDTO = z.infer<typeof deliveryPrepaymentTermsBodySchema>;
