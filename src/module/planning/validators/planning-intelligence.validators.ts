import { z } from "zod";

import { isValidPlanningDateTime } from "./planning.validators";

const dateTime = z.string().trim().refine(isValidPlanningDateTime, "Expected an ISO-8601 datetime with timezone");
const uuid = z.string().uuid();
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/).transform((value) => value.toUpperCase());
const ianaTimezone = z.string().trim().min(1).max(80).refine((value) => {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}, "Unknown IANA timezone");

export const planningIntelligenceQuerySchema = z
  .object({
    from: dateTime,
    to: dateTime,
    timezone: ianaTimezone.optional().default("Europe/Paris"),
    workshop_zone: z.string().trim().min(1).max(100).optional(),
    machine_id: uuid.optional(),
    aged_wip_days: z.coerce.number().int().min(1).max(365).optional().default(7),
  })
  .strict()
  .superRefine((value, ctx) => {
    const from = Date.parse(value.from);
    const to = Date.parse(value.to);
    if (from >= to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "'from' must be before 'to'" });
      return;
    }
    if (to - from > 13 * 7 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "Period is limited to 13 weeks" });
    }
  });

export type PlanningIntelligenceQueryDTO = z.infer<typeof planningIntelligenceQuerySchema>;

const colorMap = z.record(z.string().trim().min(1).max(160), hexColor).superRefine((value, ctx) => {
  if (Object.keys(value).length > 200) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "At most 200 color overrides are allowed" });
  }
});

export const planningPreferencesBodySchema = z
  .object({
    body: z
      .object({
        timezone: ianaTimezone,
        horizon_weeks: z.number().int().min(1).max(13),
        view_mode: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]),
        show_weekends: z.boolean(),
        machine_ids: z.array(uuid).max(100),
        status_colors: colorMap,
        client_color_overrides: colorMap,
        expected_updated_at: dateTime.optional().nullable(),
      })
      .strict(),
  })
  .strict();

export type PlanningPreferencesBodyDTO = z.infer<typeof planningPreferencesBodySchema>["body"];
