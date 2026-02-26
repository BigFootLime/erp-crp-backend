import { z } from "zod";

export const lockEntityBodySchema = z.object({
  entity_type: z.string().trim().min(1),
  entity_id: z.string().trim().min(1),
});

export const acquireLockBodySchema = lockEntityBodySchema.extend({
  reason: z.string().trim().min(1).optional(),
});

export type LockEntityBodyDTO = z.infer<typeof lockEntityBodySchema>;
export type AcquireLockBodyDTO = z.infer<typeof acquireLockBodySchema>;
