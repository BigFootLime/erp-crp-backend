import type { PlanningPriorityDTO } from "../validators/quick-commande.validators";

export type QuickCommandeResource =
  | { resource_type: "POSTE"; poste_id: string; machine_id: null }
  | { resource_type: "MACHINE"; machine_id: string; poste_id: null };

export type QuickCommandePlannedOperation = QuickCommandeResource & {
  phase: number;
  designation: string;
  duration_minutes: number;
  start_ts: string;
  end_ts: string;
};

export type QuickCommandePreviewPlan = {
  priority: PlanningPriorityDTO;
  operations: QuickCommandePlannedOperation[];
  warnings: string[];
};

export type QuickCommandePreviewResponse = {
  preview_id: string;
  expires_at: string;
  piece: { piece_technique_id: string; code_piece: string; designation: string };
  plan: QuickCommandePreviewPlan;
};

export type QuickCommandeConfirmResponse = {
  preview_id: string;
  commande: { id: number; numero: string };
  affaires: { livraison_affaire_id: number; production_affaire_id: number };
  of: { id: number; numero: string };
  planning_event_ids: string[];
};
