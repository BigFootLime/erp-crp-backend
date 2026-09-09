import { z } from 'zod';
import { consumableQuantitySchema } from '../domain/consumable-quantity';
const command={idempotencyKey:z.string().uuid(),expectedVersion:z.string().min(1).max(128)};
export const consumableReplenishmentSchema=z.object({...command,supplierId:z.string().uuid(),destinationId:z.string().uuid().nullable(),
  stockQuantity:consumableQuantitySchema.optional(),existingPurchasesReviewed:z.boolean(),reason:z.string().trim().min(3).max(1000)}).strict();
export const consumableDepletionSchema=z.object({...command,lotId:z.string().uuid(),scan:z.string().trim().min(1).max(255),expectedQuantity:consumableQuantitySchema,reason:z.string().trim().min(3).max(1000)}).strict();
export type ConsumableReplenishment= z.infer<typeof consumableReplenishmentSchema>;
export type ConsumableDepletion= z.infer<typeof consumableDepletionSchema>;
