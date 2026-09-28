export const presentationActions = [
  "start", "convert_quote", "generate_affaires", "generate_ofs", "plan",
  "start_operator", "pause_operator", "resume_operator", "declare_quantity", "stop_operator",
] as const;

export type PresentationAction = (typeof presentationActions)[number];

export type PresentationStatus =
  | "INITIALIZING" | "QUOTE_DRAFT" | "COMMANDE_CREATED" | "AFFAIRE_CREATED" | "PRODUCTION_READY"
  | "PLANNED" | "RUNNING" | "PAUSED" | "QUANTITY_DECLARED" | "COMPLETED";

export type PresentationScenario = {
  id: string;
  user_id: number;
  status: PresentationStatus;
  fixture_code: string;
  piece_technique_id: string;
  piece_technique_version_id: string;
  machine_id: string;
  client_id: string | null;
  devis_id: number | null;
  commande_id: number | null;
  affaire_id: number | null;
  of_id: number | null;
  operation_id: string | null;
  execution_id: string | null;
};

export type PresentationActor = { id: number; role: string | null | undefined };
