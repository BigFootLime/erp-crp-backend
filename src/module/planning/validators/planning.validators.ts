import { z } from "zod";

const uuid = z.string().uuid();

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "y") return true;
  if (v === "false" || v === "0" || v === "no" || v === "n") return false;
  return undefined;
}

function isValidDateTime(value: string): boolean {
  const t = Date.parse(value);
  return Number.isFinite(t);
}

export const planningEventKindSchema = z.enum(["OF_OPERATION", "MAINTENANCE", "CUSTOM"]);
export type PlanningEventKindDTO = z.infer<typeof planningEventKindSchema>;

export const planningEventStatusSchema = z.enum(["PLANNED", "IN_PROGRESS", "DONE", "CANCELLED", "BLOCKED"]);
export type PlanningEventStatusDTO = z.infer<typeof planningEventStatusSchema>;

export const planningPrioritySchema = z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]);
export type PlanningPriorityDTO = z.infer<typeof planningPrioritySchema>;

export const listPlanningResourcesQuerySchema = z.object({
  include_archived: z.preprocess(parseBoolean, z.boolean().optional()).default(false),
});
export type ListPlanningResourcesQueryDTO = z.infer<typeof listPlanningResourcesQuerySchema>;

const dateTimeString = z
  .string()
  .trim()
  .min(1)
  .refine(isValidDateTime, "Invalid datetime (expected ISO string)");

export const listPlanningEventsQuerySchema = z
  .object({
    from: dateTimeString,
    to: dateTimeString,
    machine_id: uuid.optional(),
    poste_id: uuid.optional(),
    of_id: z.coerce.number().int().positive().optional(),
    of_operation_id: uuid.optional(),
    kind: planningEventKindSchema.optional(),
    status: planningEventStatusSchema.optional(),
    priority: planningPrioritySchema.optional(),
    include_archived: z.preprocess(parseBoolean, z.boolean().optional()).default(false),
  })
  .superRefine((v, ctx) => {
    const from = Date.parse(v.from);
    const to = Date.parse(v.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    if (from >= to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'from' must be < 'to'", path: ["to"] });
    }
    if (v.machine_id && v.poste_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either machine_id or poste_id (not both)",
        path: ["poste_id"],
      });
    }
  });

export type ListPlanningEventsQueryDTO = z.infer<typeof listPlanningEventsQuerySchema>;

export const planningEventIdParamSchema = z.object({
  params: z.object({ id: uuid }),
});

export const planningEventDocumentIdParamSchema = z.object({
  params: z.object({ id: uuid, docId: uuid }),
});

export const createPlanningEventSchema = z
  .object({
    body: z
      .object({
        kind: planningEventKindSchema.optional().default("OF_OPERATION"),
        status: planningEventStatusSchema.optional().default("PLANNED"),
        priority: planningPrioritySchema.optional().default("NORMAL"),

        of_id: z.coerce.number().int().positive().optional().nullable(),
        of_operation_id: uuid.optional().nullable(),

        machine_id: uuid.optional().nullable(),
        poste_id: uuid.optional().nullable(),

        title: z.string().trim().min(1).max(500).optional(),
        description: z.string().trim().min(1).optional().nullable(),

        start_ts: dateTimeString,
        end_ts: dateTimeString,
        allow_overlap: z.boolean().optional().default(false),
      })
      .superRefine((v, ctx) => {
        if (v.machine_id && v.poste_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Provide either machine_id or poste_id (not both)",
            path: ["poste_id"],
          });
        }
        if (!v.machine_id && !v.poste_id && !v.of_operation_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "machine_id or poste_id is required (or provide of_operation_id to derive resource)",
            path: ["machine_id"],
          });
        }
        const start = Date.parse(v.start_ts);
        const end = Date.parse(v.end_ts);
        if (Number.isFinite(start) && Number.isFinite(end) && start >= end) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "start_ts must be < end_ts", path: ["end_ts"] });
        }
      }),
  });

export type CreatePlanningEventBodyDTO = z.infer<typeof createPlanningEventSchema>["body"];

export const patchPlanningEventSchema = z
  .object({
    body: z
      .object({
        patch: z
          .object({
            kind: planningEventKindSchema.optional(),
            status: planningEventStatusSchema.optional(),
            priority: planningPrioritySchema.optional(),
            of_id: z.coerce.number().int().positive().optional().nullable(),
            of_operation_id: uuid.optional().nullable(),
            machine_id: uuid.optional().nullable(),
            poste_id: uuid.optional().nullable(),
            title: z.string().trim().min(1).max(500).optional(),
            description: z.string().trim().min(1).optional().nullable(),
            start_ts: dateTimeString.optional(),
            end_ts: dateTimeString.optional(),
            allow_overlap: z.boolean().optional(),
            expected_updated_at: dateTimeString.optional(),
          })
          .strict(),
      })
      .superRefine((v, ctx) => {
        const p = v.patch;
        if (p.machine_id !== undefined && p.poste_id !== undefined && p.machine_id && p.poste_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Provide either machine_id or poste_id (not both)",
            path: ["patch", "poste_id"],
          });
        }
        if (p.start_ts !== undefined && p.end_ts !== undefined) {
          const start = Date.parse(p.start_ts);
          const end = Date.parse(p.end_ts);
          if (Number.isFinite(start) && Number.isFinite(end) && start >= end) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "start_ts must be < end_ts",
              path: ["patch", "end_ts"],
            });
          }
        }
      }),
  });

export type PatchPlanningEventBodyDTO = z.infer<typeof patchPlanningEventSchema>["body"]["patch"];

export const createPlanningEventCommentSchema = z.object({
  body: z.object({
    body: z.string().trim().min(1).max(4000),
  }),
});

export type CreatePlanningEventCommentBodyDTO = z.infer<typeof createPlanningEventCommentSchema>["body"];
