import { z } from "zod";

const orderId = z.string().regex(/^[1-9]\d{0,15}$/);
export const legacyContractQuerySchema = z.object({
  page: z.coerce.number().int().positive().max(100000).default(1),
}).strict();
export const legacyContractOrderIdSchema = orderId;
export const legacyContractBindSchema = z.object({
  commande_id: orderId,
  expected_contract_version: z.number().int().positive().max(2147483646),
  expected_source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type LegacyContractBindCommand = z.infer<typeof legacyContractBindSchema>;
