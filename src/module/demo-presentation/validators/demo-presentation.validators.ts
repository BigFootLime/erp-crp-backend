import { z } from "zod";
import { presentationActions } from "../types/demo-presentation.types";

export const presentationRunSchema = z.object({
  action: z.enum(presentationActions),
  scenario_id: z.string().uuid().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "start" && value.scenario_id !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenario_id"], message: "scenario_id is server generated for start." });
  }
  if (value.action !== "start" && value.scenario_id === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenario_id"], message: "scenario_id is required after start." });
  }
});

export type PresentationRunDTO = z.infer<typeof presentationRunSchema>;
