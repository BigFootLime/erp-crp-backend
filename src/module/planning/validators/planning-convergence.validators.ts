import { z } from "zod";

import {
  PLANNING_BROWSER_FAMILIES,
  PLANNING_SURFACES,
  PLANNING_USAGE_EVENTS,
} from "../types/planning-convergence.types";

export const planningUsageBodySchema = z.object({
  surface: z.enum(PLANNING_SURFACES),
  event_type: z.enum(PLANNING_USAGE_EVENTS),
  browser_family: z.enum(PLANNING_BROWSER_FAMILIES),
}).strict().superRefine((value, ctx) => {
  if (value.event_type === "open_premium" && value.surface !== "legacy_dashboard") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["surface"],
      message: "open_premium exige surface=legacy_dashboard",
    });
  }
});

export const planningUsageMetricsQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "from doit preceder to" });
  }
});

export type PlanningUsageBodyDTO = z.infer<typeof planningUsageBodySchema>;
export type PlanningUsageMetricsQueryDTO = z.infer<typeof planningUsageMetricsQuerySchema>;
