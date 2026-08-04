import { z } from "zod";

import {
  DASHBOARD_EXPERIENCES,
  DASHBOARD_SELECTION_SOURCES,
  DASHBOARD_USAGE_EVENTS,
} from "../types/dashboard-governance.types";

export const dashboardUsageBodySchema = z.object({
  experience: z.enum(DASHBOARD_EXPERIENCES),
  event_type: z.enum(DASHBOARD_USAGE_EVENTS),
  selection_source: z.enum(DASHBOARD_SELECTION_SOURCES),
  previous_experience: z.enum(DASHBOARD_EXPERIENCES).optional(),
}).strict().superRefine((value, ctx) => {
  const issue = (path: "selection_source" | "previous_experience", message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };

  if (value.event_type === "switch") {
    if (value.selection_source !== "switch") {
      issue("selection_source", "switch exige selection_source=switch");
    }
    if (!value.previous_experience || value.previous_experience === value.experience) {
      issue("previous_experience", "switch exige une expérience précédente différente");
    }
    return;
  }

  if (value.previous_experience !== undefined) {
    issue("previous_experience", "previous_experience est réservé à switch");
  }

  const requiredSource = {
    deep_link: "query",
    preference_migrated: "migration",
    fallback: "rollback",
  } as const;
  if (value.event_type in requiredSource) {
    const expected = requiredSource[value.event_type as keyof typeof requiredSource];
    if (value.selection_source !== expected) {
      issue("selection_source", `${value.event_type} exige selection_source=${expected}`);
    }
  } else if (!(["default", "preference", "switch"] as const).includes(
    value.selection_source as "default" | "preference" | "switch"
  )) {
    issue("selection_source", "view accepte uniquement default, preference ou switch");
  }
});

export const dashboardMetricsQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "from doit précéder to" });
  }
});

export type DashboardUsageBodyDTO = z.infer<typeof dashboardUsageBodySchema>;
export type DashboardMetricsQueryDTO = z.infer<typeof dashboardMetricsQuerySchema>;
