import { z } from "zod";
export const subcontractTransferSchema = z
  .object({
    return_id: z.string().uuid(),
    successor_operation_id: z.string().uuid(),
    quantity: z.number().int().positive(),
    expected_version: z.string().length(64),
    reason: z.string().trim().min(3).max(1000),
    action: z.enum(["RELEASE", "RETURN"]).default("RELEASE"),
  })
  .strict();
export type SubcontractTransferInput = z.infer<
  typeof subcontractTransferSchema
>;
