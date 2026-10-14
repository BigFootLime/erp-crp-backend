import { z } from "zod";
const money = z.string().regex(/^\d{1,14}(?:\.\d{1,2})?$/, "Montant attendu avec deux décimales maximum");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD")
  .refine(value => { const parsed=new Date(value+"T00:00:00Z");return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value; },"Date calendrier invalide");
export const customerRefundPreviewSchema = z.object({ avoir_id: z.coerce.number().int().positive(), amount: money.optional() }).strict();
export const registerCustomerRefundSchema = customerRefundPreviewSchema.extend({
  amount: money, preview_hash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true),
  value_date: date, booking_date: date, mode: z.string().trim().min(1).max(80),
  reference: z.string().trim().min(1).max(200), reason: z.string().trim().min(8).max(2000),
  proof_document_id: z.string().uuid().nullable().optional(),
}).strict().superRefine((input,context) => {
  if (input.booking_date < input.value_date) context.addIssue({code:z.ZodIssueCode.custom,path:["booking_date"],message:"La date comptable ne peut pas précéder la date de valeur."});
  if (/^0(?:\.0+)?$/.test(input.amount)) context.addIssue({code:z.ZodIssueCode.custom,path:["amount"],message:"Le remboursement doit être positif."});
});
export type CustomerRefundPreviewDTO = z.infer<typeof customerRefundPreviewSchema>;
export type RegisterCustomerRefundDTO = z.infer<typeof registerCustomerRefundSchema>;
