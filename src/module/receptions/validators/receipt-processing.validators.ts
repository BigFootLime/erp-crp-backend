import { z } from "zod";
import { receivedMaterialBarsSchema } from '../../stock/validators/material-bars.validators';
const command = {
  idempotencyKey: z.string().guid(),
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
  .object({ ...command, stockArticleId: z.string().guid() })
  .strict();
export const stockProcessingSchema = z
  .object({
    ...command,
    quantity: z.number().finite().positive(),
    magasinId: z.string().guid(),
    emplacementId: z.number().int().positive(),
    materialBars: receivedMaterialBarsSchema.optional(),
  })
  .strict();
export const toolStockProcessingSchema = z
  .object({ ...command, quantity: z.number().finite().positive() })
  .strict();
export const subcontractProcessingSchema = z
  .object({
    ...command,
    returnEventId: z.string().guid().optional(),
    origins: z
      .array(
        z.object({
          issueEventId: z.string().guid(),
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
    packagingId: z.string().guid(),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();
const operatorMeasurement = z.object({
  label: z.string().trim().min(1).max(120),
  valueMm: z.number().finite().positive().max(1000000000).multipleOf(0.001),
  confirmed: z.literal(true),
  result: z.enum(["OK", "NOK"]).optional(),
}).strict();
export const operatorControlSchema = z.object({
  ...command,
  kind: z.literal("MP"),
  verdict: z.enum(["CONFORME", "NON_CONFORME"]),
  measurements: z.array(operatorMeasurement).min(1).max(30),
  grade: z.object({ value: z.string().trim().min(1).max(120), confirmed: z.literal(true) }).strict().optional(),
  note: z.string().trim().max(2000).optional(),
  inspection: z.object({
    appearance: z.enum(["OK", "NOK"]),
    quantity: z.number().min(0).max(1_000_000_000).multipleOf(0.000001),
  }).strict().optional(),
  stock: stockProcessingSchema.pick({ magasinId: true, emplacementId: true, materialBars: true }).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.verdict === "CONFORME" && input.measurements.some(item => item.result === "NOK")) {
    ctx.addIssue({ code: "custom", path: ["verdict"], message: "Une cote non conforme impose le constat non conforme." });
  }
  if (input.verdict === "NON_CONFORME" && (input.note?.length ?? 0) < 3) {
    ctx.addIssue({ code: "custom", path: ["note"], message: "Décrivez la non-conformité constatée." });
  }
  if (input.verdict === "CONFORME" && input.inspection?.appearance === "NOK") {
    ctx.addIssue({ code: "custom", path: ["inspection", "appearance"], message: "Un défaut d’aspect impose le constat non conforme." });
  }
  if (input.stock && (!input.inspection || input.verdict !== "CONFORME")) {
    ctx.addIssue({ code: "custom", path: ["stock"], message: "La mise en stock exige un contrôle conforme de l’aspect et de la quantité." });
  }
  if (input.inspection && input.verdict === "CONFORME" && !input.stock) {
    ctx.addIssue({ code: "custom", path: ["stock"], message: "Confirmez la destination du stock." });
  }
});
export type OperatorControlBody = z.infer<typeof operatorControlSchema>;

export const subcontractReturnControlSchema = z.object({
  idempotencyKey: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  sourceIssueId: z.string().uuid(),
  appearance: z.enum(["OK", "NOK"]),
  verdict: z.enum(["CONFORME", "NON_CONFORME"]),
  measurements: z.array(z.object({
    controlId: z.string().uuid(),
    characteristicKey: z.string().trim().min(1).max(40),
    sampleNo: z.number().int().min(1),
    valueMm: z.number().finite().min(0).max(1_000_000),
  }).strict()).max(100),
  paperMeasurement: z.object({
    label: z.string().trim().min(1).max(100),
    valueMm: z.number().finite().min(0).max(1_000_000),
  }).strict().optional(),
  comment: z.string().trim().min(1).max(1000).optional(),
}).strict();

export type SubcontractReturnControlBody = z.infer<typeof subcontractReturnControlSchema>;
export type PackReceiptBody = z.infer<typeof packReceiptSchema>;
export type ProcessingQuery = z.infer<typeof processingQuerySchema>;
