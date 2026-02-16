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
