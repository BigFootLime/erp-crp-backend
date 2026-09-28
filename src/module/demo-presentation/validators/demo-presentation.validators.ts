import { z } from "zod";
import { presentationActions } from "../types/demo-presentation.types";

export const presentationRunSchema = z.object({
  action: z.enum(presentationActions),
  scenario_id: z.string().uuid().optional(),
  client_id: z.string().trim().min(1).optional(),
  devis_id: z.coerce.number().int().positive().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.action === "prepare_client" || value.action === "start") && value.scenario_id !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenario_id"], message: "scenario_id is server generated for this action." });
  }
  if (value.action !== "prepare_client" && value.action !== "start" && value.scenario_id === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenario_id"], message: "scenario_id is required after prepare_client." });
  }
  if (value.action !== "adopt_client" && value.client_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["client_id"], message: "client_id is only accepted for adopt_client." });
  if (value.action !== "adopt_devis" && value.devis_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["devis_id"], message: "devis_id is only accepted for adopt_devis." });
});

export type PresentationRunDTO = z.infer<typeof presentationRunSchema>;
