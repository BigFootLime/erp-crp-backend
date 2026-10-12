import { z } from 'zod';
const quantity = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/, 'Quantité positive, trois décimales maximum')
  .refine(value => Number(value) > 0, 'La quantité doit être positive');
export const deliveryUrgencyQuery = z.object({ quantity: quantity.optional() }).strict();
export const deliveryUrgencyBody = z.object({
  quantity,
  preview_hash: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().trim().min(10).max(1000),
}).strict();
export const deliveryUrgencyRequestParams = z.object({ requestId: z.string().uuid() }).strict();
export const deliveryUrgencyKey = z.string().uuid('Une clé de requête UUID est requise');
export const deliveryUrgencyCancelBody = z.object({
  expected_version: z.number().int().positive(),
  reason: z.string().trim().min(10).max(1000),
  preview_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();
export const deliveryUrgencyRetainBody = deliveryUrgencyCancelBody.extend({
  preview_hash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export const deliveryUrgencyRestitutionBody = deliveryUrgencyRetainBody.extend({ fee_decision: z.literal('KEEP') }).strict();
export type DeliveryUrgencyRestitutionBody = z.infer<typeof deliveryUrgencyRestitutionBody>;
export type DeliveryUrgencyBody = z.infer<typeof deliveryUrgencyBody>;
export const deliveryUrgencyWithdrawalBody = z.object({
  expected_version: z.number().int().positive(),
  preview_hash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type DeliveryUrgencyCancelBody = z.infer<typeof deliveryUrgencyCancelBody>;
