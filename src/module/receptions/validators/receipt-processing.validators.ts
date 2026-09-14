import { z } from "zod";
const command = {
  idempotencyKey: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
};
export const processingQuerySchema = z
  .object({
    q: z.string().trim().max(160).optional(),
    stage: z
      .enum(["TO_CONTROL", "TO_PACK", "TO_STOCK", "DONE", "BLOCKED"])
      .optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export const packReceiptSchema = z
  .object({
    ...command,
    quantity: z.number().finite().positive().multipleOf(0.000001),
    packaging: z.string().trim().min(1).max(200),
    packageCount: z.number().int().positive().max(100000),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
export const mapReceiptArticleSchema = z
  .object({ ...command, stockArticleId: z.string().uuid() })
  .strict();
export const stockProcessingSchema = z
  .object({
    ...command,
    quantity: z.number().finite().positive(),
    magasinId: z.string().uuid(),
    emplacementId: z.number().int().positive(),
  })
  .strict();
export const toolStockProcessingSchema = z
  .object({ ...command, quantity: z.number().finite().positive() })
  .strict();
export const subcontractProcessingSchema = z
  .object({
    ...command,
    returnEventId: z.string().uuid().optional(),
    origins: z
      .array(
        z.object({
          issueEventId: z.string().uuid(),
          quantity: z.number().finite().positive(),
        }),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (b) =>
      new Set(b.origins.map((o) => o.issueEventId)).size === b.origins.length,
    "Une origine ne peut être répétée.",
  );
export const reconcileReceiptSchema = z
  .object({ ...command, reason: z.string().trim().min(3).max(2000) })
  .strict();
export const voidPackagingSchema = z
  .object({
    ...command,
    packagingId: z.string().uuid(),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();
export type PackReceiptBody = z.infer<typeof packReceiptSchema>;
export type ProcessingQuery = z.infer<typeof processingQuerySchema>;
