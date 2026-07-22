import { z } from "zod";

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional().nullable();

export const machineUnavailabilityCauseSchema = z.enum([
  "PREVENTIVE_MAINTENANCE",
  "BREAKDOWN",
  "QUALIFICATION",
  "RESERVATION",
  "WORKSHOP_CLOSURE",
  "OPERATOR_ABSENCE",
  "OTHER",
]);

export const machineParkIdParamSchema = z.object({ params: z.object({ id: uuid }).strict() }).strict();
export const machineUnavailabilityIdParamSchema = z.object({
  params: z.object({ id: uuid, unavailabilityId: uuid }).strict(),
}).strict();
export const machineMaintenancePlanIdParamSchema = z.object({
  params: z.object({ id: uuid, planId: uuid }).strict(),
}).strict();

export const listMachineUnavailabilitySchema = z.object({
  query: z.object({
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    include_archived: z.enum(["true", "false"]).optional().default("false").transform((v) => v === "true"),
  }).strict().superRefine((v, ctx) => {
    if ((v.from && !v.to) || (!v.from && v.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [v.from ? "to" : "from"], message: "from and to must be provided together" });
    }
    if (v.from && v.to && Date.parse(v.from) >= Date.parse(v.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "from must be before to" });
    }
  }),
}).strict();

export const createMachineUnavailabilitySchema = z.object({
  body: z.object({
    cause: machineUnavailabilityCauseSchema,
    comment: optionalText(4000),
    source: z.string().trim().min(1).max(120).optional().default("machine_park"),
    start_ts: isoDateTime,
    end_ts: isoDateTime,
    maintenance_plan_id: uuid.optional().nullable(),
  }).strict().superRefine((v, ctx) => {
    if (Date.parse(v.start_ts) >= Date.parse(v.end_ts)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["end_ts"], message: "start_ts must be before end_ts" });
    }
    if (v.cause === "OTHER" && !v.comment) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["comment"], message: "A reason is required for OTHER" });
    }
  }),
}).strict();

const machineMaintenancePlanBody = z.object({
    title: z.string().trim().min(1).max(240),
    status: z.enum(["ACTIVE", "PAUSED", "COMPLETED"]).optional().default("ACTIVE"),
    frequency_days: z.number().int().positive().max(3650).optional().nullable(),
    frequency_counter: z.number().positive().max(999999999).optional().nullable(),
    counter_unit: optionalText(40),
    next_due_at: z.string().date().optional().nullable(),
    responsible_user_id: z.number().int().positive().optional().nullable(),
    checklist: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(240) }).strict()).max(100).optional().default([]),
    document_id: uuid.optional().nullable(),
    source: z.string().trim().min(1).max(120).optional().default("internal"),
    notes: optionalText(4000),
  }).strict();

export const createMachineMaintenancePlanSchema = z.object({
  body: machineMaintenancePlanBody.superRefine((v, ctx) => {
    if (!v.frequency_days && !v.frequency_counter && !v.next_due_at) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["next_due_at"], message: "A date or frequency is required" });
    }
    if (v.frequency_counter && !v.counter_unit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["counter_unit"], message: "Counter unit is required" });
    }
  }),
}).strict();

export const updateMachineMaintenancePlanSchema = z.object({
  body: machineMaintenancePlanBody.partial().extend({
    expected_updated_at: isoDateTime,
  }).strict(),
}).strict();

export const reactivateMachineSchema = z.object({
  body: z.object({ expected_updated_at: isoDateTime }).strict(),
}).strict();

export const machineDocumentIdParamSchema = z.object({
  params: z.object({ id: uuid, documentId: uuid }).strict(),
}).strict();

export const createMachineDocumentSchema = z.object({
  body: z.object({
    title: z.string().trim().min(1).max(240),
    document_type: z.enum(["OFFICIAL_PAGE", "BROCHURE_PDF", "MANUAL", "IMAGE", "RESALE_LISTING", "INTERNAL_NOTE", "CERTIFICATE", "MAINTENANCE", "PHOTO", "MODEL_3D"]),
    url: z.string().url().max(2000),
    revision: optionalText(80),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().nullable(),
    mime_type: optionalText(160),
    size_bytes: z.number().int().positive().max(2_000_000_000).optional().nullable(),
    authored_at: isoDateTime.optional().nullable(),
    source_type: z.enum(["manufacturer_page", "manufacturer_pdf", "resale_listing", "internal_note", "mixed", "unknown"]),
    source_confidence: z.enum(["official", "resale_listing", "estimated", "internal", "unknown"]),
    source_notes: optionalText(2000),
  }).strict(),
}).strict();

export const uploadMachineDocumentSchema = z.object({
  body: z.object({
    title: z.string().trim().min(1).max(240),
    document_type: z.enum(["OFFICIAL_PAGE", "BROCHURE_PDF", "MANUAL", "IMAGE", "RESALE_LISTING", "INTERNAL_NOTE", "CERTIFICATE", "MAINTENANCE", "PHOTO", "MODEL_3D"]),
    revision: optionalText(80),
    authored_at: isoDateTime.optional().nullable(),
    source_type: z.enum(["manufacturer_page", "manufacturer_pdf", "resale_listing", "internal_note", "mixed", "unknown"]),
    source_confidence: z.enum(["official", "resale_listing", "estimated", "internal", "unknown"]),
    source_notes: optionalText(2000),
  }).strict(),
}).strict();

export const createMachineMaintenanceEventSchema = z.object({
  body: z.object({
    maintenance_plan_id: uuid.optional().nullable(),
    event_type: z.enum(["SCHEDULED", "STARTED", "COMPLETED", "CANCELLED", "NOTE"]),
    occurred_at: isoDateTime.optional(),
    due_at: isoDateTime.optional().nullable(),
    checklist_result: z.array(z.object({ id: z.string().min(1).max(80), completed: z.boolean(), note: optionalText(1000) }).strict()).max(100).optional().default([]),
    notes: optionalText(4000),
  }).strict(),
}).strict();

export type ListMachineUnavailabilityQueryDTO = z.infer<typeof listMachineUnavailabilitySchema>["query"];
export type CreateMachineUnavailabilityBodyDTO = z.infer<typeof createMachineUnavailabilitySchema>["body"];
export type CreateMachineMaintenancePlanBodyDTO = z.infer<typeof createMachineMaintenancePlanSchema>["body"];
export type UpdateMachineMaintenancePlanBodyDTO = z.infer<typeof updateMachineMaintenancePlanSchema>["body"];
export type CreateMachineMaintenanceEventBodyDTO = z.infer<typeof createMachineMaintenanceEventSchema>["body"];
export type CreateMachineDocumentBodyDTO = z.infer<typeof createMachineDocumentSchema>["body"];
export type UploadMachineDocumentBodyDTO = z.infer<typeof uploadMachineDocumentSchema>["body"];
