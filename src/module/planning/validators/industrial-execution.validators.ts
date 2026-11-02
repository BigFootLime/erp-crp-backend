import { z } from "zod";
export const industrialExecutionSchema = z
  .object({
    proposal_indexes: z
      .array(z.number().int().min(0).max(100000))
      .min(1)
      .max(20)
      .refine(
        (v) => new Set(v).size === v.length,
        "Sélectionnez des propositions distinctes.",
      ),
    request_key: z.string().trim().min(8).max(120),
    supplier_id: z.string().uuid().optional(),
  })
  .strict();
export type IndustrialExecutionCommand = z.infer<
  typeof industrialExecutionSchema
>;
