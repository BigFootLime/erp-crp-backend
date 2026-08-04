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
}).strict();

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
