import { z } from 'zod';
import { packagingPolicySchema } from '../domain/finished-packaging';
export const packagingLotIdentity = z.object({ id: z.string().uuid() });
export const packagingPrintIdentity = packagingLotIdentity.extend({ packagingId: z.string().uuid() });
export const packagingCommand = z.object({ idempotencyKey: z.string().uuid(), quantity: z.number().int().positive(), reason: z.string().trim().min(10).max(1000), legacyPolicy: packagingPolicySchema.optional() }).strict();
export const packagingPrintCommand = z.object({ idempotencyKey: z.string().uuid(), reason: z.string().trim().min(10).max(1000) }).strict();
export type PackagingCommand = z.infer<typeof packagingCommand>;
