import { z } from "zod";

const uuid = z.string().uuid();

function isValidDateTime(value: string): boolean {
  const t = Date.parse(value);
  return Number.isFinite(t);
}

const dateTimeString = z
  .string()
  .trim()
  .min(1)
  .refine(isValidDateTime, "Invalid datetime (expected ISO string)");

export const planningPrioritySchema = z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]);
export type PlanningPriorityDTO = z.infer<typeof planningPrioritySchema>;

export const previewQuickCommandeSchema = z
  .object({
    body: z
      .object({
        client_id: z.string().trim().min(1),
        piece_technique_id: uuid,
        quantity: z.coerce.number().positive().default(1),

        // Soft deadline (used for warnings in preview; confirm uses it for OF due date).
        deadline_ts: dateTimeString,
        start_ts: dateTimeString.optional().nullable(),

        poste_id: uuid.optional().nullable(),
        machine_id: uuid.optional().nullable(),

        step_minutes: z.coerce.number().int().min(1).max(120).optional().default(15),
        priority: planningPrioritySchema.optional().default("NORMAL"),
      })
      .strict()
      .superRefine((v, ctx) => {
        if (v.poste_id && v.machine_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Provide either poste_id or machine_id (not both)",
            path: ["machine_id"],
          });
        }
      })
  })
  .strict();

export type PreviewQuickCommandeBodyDTO = z.infer<typeof previewQuickCommandeSchema>["body"];

export const confirmQuickCommandeSchema = z
  .object({
    body: z
      .object({
        preview_id: uuid,
        overrides: z
          .array(
            z
              .object({
                phase: z.coerce.number().int().positive(),
                start_ts: dateTimeString.optional(),
                end_ts: dateTimeString.optional(),
                poste_id: uuid.optional().nullable(),
                machine_id: uuid.optional().nullable(),
              })
              .strict()
              .superRefine((v, ctx) => {
                if (v.poste_id && v.machine_id) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "Provide either poste_id or machine_id (not both)",
                    path: ["machine_id"],
                  });
                }

                const hasStart = v.start_ts !== undefined;
                const hasEnd = v.end_ts !== undefined;
                if (hasStart !== hasEnd) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "Provide both start_ts and end_ts (or neither)",
                    path: [hasStart ? "end_ts" : "start_ts"],
                  });
                  return;
                }

                if (v.start_ts && v.end_ts) {
                  const start = Date.parse(v.start_ts);
                  const end = Date.parse(v.end_ts);
                  if (Number.isFinite(start) && Number.isFinite(end) && start >= end) {
                    ctx.addIssue({
                      code: z.ZodIssueCode.custom,
                      message: "start_ts must be < end_ts",
                      path: ["end_ts"],
                    });
                  }
                }
              })
          )
          .optional()
          .default([]),
      })
      .strict(),
  })
  .strict();

export type ConfirmQuickCommandeBodyDTO = z.infer<typeof confirmQuickCommandeSchema>["body"];
