import { z } from "zod";
const uuid = z.string().uuid();
const reason = z.string().trim().min(3).max(2000);
export const worklistQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  queue: z
    .enum([
      "ALL",
      "OVERDUE",
      "PREPARATION",
      "REVIEW",
      "READY",
      "PLANNED",
      "RUNNING",
      "COVERED",
    ])
    .default("ALL"),
  kind: z
    .enum(["ALL", "ROOT", "CHILD", "ASSEMBLY", "CONSOLIDATION"])
    .default("ALL"),
  client_id: z.string().max(3).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type WorklistQuery = z.infer<typeof worklistQuerySchema>;
const requirement = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("REQUIRED") }).strict(),
  z.object({ mode: z.literal("NOT_REQUIRED"), reason }).strict(),
]);
export const preparationDecisionsSchema = z
  .object({
    material: requirement.optional(),
    treatment: requirement.optional(),
    subcontract: requirement.optional(),
    manufacturing_plan_required: z.boolean().optional(),
    programming: z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("NONE"), reason }).strict(),
        z
          .object({
            mode: z.literal("EXISTING"),
            reference: z.string().trim().min(1).max(200),
          })
          .strict(),
        z
          .object({
            mode: z.literal("TASK"),
            task_id: uuid,
            estimated_hours: z.number().positive().max(10000),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export const savePreparationDecisionsSchema = z
  .object({
    expected_updated_at: z.string().min(1),
    version_id: uuid,
    expected_version: z.number().int().min(0),
    decisions: preparationDecisionsSchema,
  })
  .strict();
export const preparationVersionSchema = z
  .object({ expected_updated_at: z.string().min(1), version_id: uuid })
  .strict();
export const preparationReviewSchema = z
  .object({
    expected_updated_at: z.string().min(1),
    source_hash: z.string().length(64),
    reason,
  })
  .strict();
export const consolidationSchema = z
  .object({
    sources: z
      .array(
        z
          .object({
            of_id: z.number().int().positive(),
            expected_updated_at: z.string().min(1),
          })
          .strict(),
      )
      .min(2)
      .max(100),
    surplus_quantity: z
      .number()
      .min(0)
      .max(1000000)
      .multipleOf(0.001)
      .default(0),
    reason,
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.sources.map((s) => s.of_id)).size !== v.sources.length)
      c.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources"],
        message: "Un OF ne peut apparaître deux fois.",
      });
  });
export const createConsolidationSchema = z
  .object({
    request: consolidationSchema,
    idempotency_key: uuid,
    preview_hash: z.string().length(64),
  })
  .strict();
export const dissolveConsolidationSchema = z
  .object({ expected_updated_at: z.string().min(1), reason })
  .strict();
export type ConsolidationRequest = z.infer<typeof consolidationSchema>;
export const programmingTaskSchema = z
  .object({
    decisions: preparationDecisionsSchema
      .omit({ programming: true })
      .optional(),
    expected_profile_version: z.number().int().min(0).optional(),
    expected_updated_at: z.string().min(1),
    expected_task_updated_at: z.string().optional(),
    assignee_id: z.number().int().positive(),
    estimated_hours: z.number().positive().max(10000),
    status: z.enum(["TODO", "DONE"]),
    program_reference: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((x) => x.status !== "DONE" || Boolean(x.program_reference), {
    path: ["program_reference"],
    message: "La référence du programme réalisé est requise.",
  });
export const importPurchasesSchema = z
  .object({
    expected_updated_at: z.string().min(1),
    source_version_id: uuid.nullable(),
  })
  .strict();
export const stockReuseSchema = z
  .object({
    expected_updated_at: z.string().min(1),
    source_hash: z.string().length(64),
    lot_id: uuid,
    stock_batch_id: uuid,
    quantity: z.number().positive().multipleOf(0.001),
    disposition: z.enum(["REUSE", "REWORK"]),
    justification: reason,
    approval_reference: reason,
    idempotency_key: uuid,
  })
  .strict();
