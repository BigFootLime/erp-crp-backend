import { z } from 'zod';
import { consumableQuantitySchema } from '../domain/consumable-quantity';
const command={idempotencyKey:z.string().guid(),expectedVersion:z.string().min(1).max(128)};
export const consumableReplenishmentSchema=z.object({...command,supplierId:z.string().guid(),destinationId:z.string().guid().nullable(),
  stockQuantity:consumableQuantitySchema.optional(),existingPurchasesReviewed:z.boolean(),reason:z.string().trim().min(3).max(1000)}).strict();
export const consumableDepletionSchema=z.object({...command,lotId:z.string().guid().nullable().optional(),scan:z.string().trim().min(1).max(255),expectedQuantity:consumableQuantitySchema,reason:z.string().trim().min(3).max(1000),
  replenishment:z.object({supplierId:z.string().guid(),destinationId:z.string().guid().nullable(),existingPurchasesReviewed:z.boolean()}).strict().optional()}).strict();
export type ConsumableReplenishment= z.infer<typeof consumableReplenishmentSchema>;
export type ConsumableDepletion= z.infer<typeof consumableDepletionSchema>;
