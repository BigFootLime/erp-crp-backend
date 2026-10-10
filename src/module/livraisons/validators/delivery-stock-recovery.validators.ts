import { z } from 'zod';
export const deliveryStockRecoveryParams = z.object({ allocationId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const deliveryStockRecoveryBody = z.object({
  preview_hash: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().trim().min(3).max(500),
}).strict();
export const deliveryStockRecoveryKey = z.string().trim().min(8).max(200);
export const deliveryStockRecoveryResult = z.object({
  allocation_id: z.number().int().positive(), livraison_affaire_id: z.number().int().positive(), commande_id: z.number().int().positive(),
  reserved_qty: z.number().finite().nonnegative(), shortage_qty: z.number().finite().nonnegative(),
  reservation_ids: z.array(z.string().uuid()).min(1), idempotent_replay: z.boolean(),
}).strict();
