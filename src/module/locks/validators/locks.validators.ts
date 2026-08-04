import { z } from "zod";

export const lockEntityBodySchema = z.object({
  entity_type: z.string().trim().min(1).max(64),
  entity_id: z.string().trim().min(1).max(128),
}).strict();

export const acquireLockBodySchema = lockEntityBodySchema.extend({
  reason: z.string().trim().min(1).max(2000).optional(),
}).strict();

export type LockEntityBodyDTO = z.infer<typeof lockEntityBodySchema>;
export type AcquireLockBodyDTO = z.infer<typeof acquireLockBodySchema>;
