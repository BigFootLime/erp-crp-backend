import { z } from 'zod';
export const productionLossIdentity = z.object({ id: z.coerce.number().int().positive() });
export const productionLossCommand = z.object({ operationId: z.string().guid(), quantity: z.number().int().positive().max(1e9),
    expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: z.string().guid(), reason: z.string().trim().min(10).max(2000) }).strict();
export type ProductionLossCommand = z.infer<typeof productionLossCommand>;
