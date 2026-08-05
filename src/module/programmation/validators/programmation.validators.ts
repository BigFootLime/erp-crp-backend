import { z } from "zod";

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

const dateTimeString = z
  .string()
  .trim()
  .min(1)
  .refine(isValidDateTime, "Invalid datetime (expected ISO string)");

const dateOnlyString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected calendar date YYYY-MM-DD").refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}, "Invalid calendar date");

const timezoneString = z.string().trim().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}, "Unknown IANA timezone");

const rescheduleCandidateSchema = z.object({
  start_date: dateOnlyString,
  end_date: dateOnlyString,
  programmer_user_id: z.number().int().positive().nullable(),
  machine_id: z.string().uuid().nullable(),
  poste_id: z.string().uuid().nullable(),
  calendar_id: z.string().uuid().nullable(),
}).strict().superRefine((value, ctx) => {
  const start = Date.parse(`${value.start_date}T00:00:00Z`);
  const end = Date.parse(`${value.end_date}T00:00:00Z`);
  if (start > end) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "start_date must be <= end_date", path: ["end_date"] });
  }
  if (Number.isFinite(start) && Number.isFinite(end) && (end - start) / 86_400_000 > 366) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A reschedule cannot span more than 367 calendar days", path: ["end_date"] });
  }
});

const rescheduleReason = z.string().trim().min(5).max(1000);
const idempotencyKey = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Invalid idempotency key");
const rescheduleSource = z.enum(["POINTER", "KEYBOARD", "TOUCH", "API"]);

export const programmationIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }).strict(),
}).strict();

export const programmationRescheduleOperationParamSchema = z.object({
  params: z.object({ id: z.string().uuid(), operationId: z.string().uuid() }).strict(),
}).strict();

export const previewProgrammationRescheduleSchema = z.object({
  body: z.object({
    expected_version: z.number().int().positive(),
    reason: rescheduleReason,
    timezone: timezoneString,
    source: rescheduleSource.default("API"),
    candidate: rescheduleCandidateSchema,
  }).strict(),
}).strict();

export const commitProgrammationRescheduleSchema = z.object({
  body: z.object({
    expected_version: z.number().int().positive(),
    reason: rescheduleReason,
    timezone: timezoneString,
    source: rescheduleSource.default("API"),
    idempotency_key: idempotencyKey,
    preview_token: z.string().regex(/^[0-9a-f]{64}$/),
    candidate: rescheduleCandidateSchema,
  }).strict(),
}).strict();

export const cancelProgrammationRescheduleSchema = z.object({
  body: z.object({
    expected_version: z.number().int().positive(),
    reason: rescheduleReason,
    timezone: timezoneString,
    source: rescheduleSource.default("API"),
    idempotency_key: idempotencyKey,
  }).strict(),
}).strict();

export const listProgrammationsQuerySchema = z
  .object({
    from: dateTimeString,
    to: dateTimeString,
    include_archived: z.preprocess(parseBoolean, z.boolean().optional()).default(false),
  })
  .superRefine((v, ctx) => {
    const from = Date.parse(v.from);
    const to = Date.parse(v.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    if (from >= to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'from' must be < 'to'", path: ["to"] });
    }
  });

export type ListProgrammationsQueryDTO = z.infer<typeof listProgrammationsQuerySchema>;
export type PreviewProgrammationRescheduleBodyDTO = z.infer<typeof previewProgrammationRescheduleSchema>["body"];
export type CommitProgrammationRescheduleBodyDTO = z.infer<typeof commitProgrammationRescheduleSchema>["body"];
export type CancelProgrammationRescheduleBodyDTO = z.infer<typeof cancelProgrammationRescheduleSchema>["body"];
