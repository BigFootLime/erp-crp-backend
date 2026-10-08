import { z } from 'zod';

export const assemblyComponentWithdrawalSchema = z.object({
  idempotencyKey: z.string().uuid(),
  expectedVersion: z.string().min(1).max(128),
  operationId: z.string().uuid(),
  quantity: z.number().int().positive().max(1_000_000_000),
}).strict();
export const assemblyComponentPreviewSchema = z.object({
  quantity: z.coerce.number().int().positive().max(1_000_000_000).optional(),
}).strict();
export type AssemblyComponentWithdrawal = z.infer<typeof assemblyComponentWithdrawalSchema>;

export const assemblyComponentReturnSchema = z.object({
  idempotencyKey: z.string().uuid(),
  expectedVersion: z.string().min(1).max(128),
  reason: z.string().trim().min(3).max(1000),
  confirmPhysicalReturn: z.literal(true),
}).strict();
export type AssemblyComponentReturn = z.infer<typeof assemblyComponentReturnSchema>;
