import { z } from "zod";
import { presentationActions } from "../types/demo-presentation.types";

export const presentationRunSchema = z.object({
  action: z.enum(presentationActions),
  scenario_id: z.string().uuid().optional(),
  client_id: z.string().trim().min(1).optional(),
  piece_technique_id: z.string().uuid().optional(),
  gamme_id: z.string().uuid().optional(),
  article_id: z.string().uuid().optional(),
  receipt_id: z.string().uuid().optional(),
  livraison_id: z.string().uuid().optional(),
  plan_id: z.string().uuid().optional(),
  quality_control_id: z.string().uuid().optional(),
  quality_release_decision_id: z.string().uuid().optional(),
  devis_id: z.coerce.number().int().positive().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.action === "prepare_client" || value.action === "start") && value.scenario_id !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenario_id"], message: "scenario_id is server generated for this action." });
  }
  if (value.action !== "prepare_client" && value.action !== "start" && value.scenario_id === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenario_id"], message: "scenario_id is required after prepare_client." });
  }
  if (value.action !== "adopt_client" && value.client_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["client_id"], message: "client_id is only accepted for adopt_client." });
  if (value.action !== "adopt_piece" && value.piece_technique_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["piece_technique_id"], message: "piece_technique_id is only accepted for adopt_piece." });
  if (value.action !== "adopt_gamme" && value.gamme_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gamme_id"], message: "gamme_id is only accepted for adopt_gamme." });
  if (value.action !== "adopt_article" && value.article_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["article_id"], message: "article_id is only accepted for adopt_article." });
  if (value.action !== "adopt_receipt" && value.receipt_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receipt_id"], message: "receipt_id is only accepted for adopt_receipt." });
  if (value.action !== "adopt_delivery" && value.livraison_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["livraison_id"], message: "livraison_id is only accepted for adopt_delivery." });
  if (value.action !== "adopt_quality_plan" && value.plan_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["plan_id"], message: "plan_id is only accepted for adopt_quality_plan." });
  if (value.action !== "adopt_quality_release" && value.quality_control_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["quality_control_id"], message: "quality_control_id is only accepted for adopt_quality_release." });
  if (value.action !== "adopt_quality_release" && value.quality_release_decision_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["quality_release_decision_id"], message: "quality_release_decision_id is only accepted for adopt_quality_release." });
  if (value.action !== "adopt_devis" && value.devis_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["devis_id"], message: "devis_id is only accepted for adopt_devis." });
});

export type PresentationRunDTO = z.infer<typeof presentationRunSchema>;
