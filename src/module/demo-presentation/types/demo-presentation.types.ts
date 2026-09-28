export const presentationActions = [
  "start", "prepare_client", "adopt_client", "prepare_piece", "adopt_piece", "prepare_gamme", "adopt_gamme", "prepare_article", "adopt_article", "prepare_devis", "adopt_devis", "convert_quote", "generate_affaires", "generate_ofs", "plan", "release_operator",
  "start_operator", "pause_operator", "resume_operator", "declare_quantity", "stop_operator", "finish_operation", "finish_of", "prepare_receipt", "adopt_receipt",
] as const;

export type PresentationAction = (typeof presentationActions)[number];

export type PresentationStatus =
  | "INITIALIZING" | "CLIENT_PREPARED" | "CLIENT_CREATED" | "PIECE_PREPARED" | "PIECE_CREATED" | "GAMME_PREPARED" | "GAMME_APPLICABLE" | "ARTICLE_PREPARED" | "ARTICLE_CREATED" | "QUOTE_PREPARED" | "QUOTE_DRAFT" | "COMMANDE_CREATED" | "AFFAIRE_CREATED" | "PRODUCTION_READY"
  | "PLANNED" | "OPERATOR_READY" | "RUNNING" | "PAUSED" | "QUANTITY_DECLARED" | "OPERATION_FINISHED" | "OF_FINISHED" | "COMPLETED" | "RECEIPT_PREPARED" | "RECEIPTED";

export type PresentationScenario = {
  id: string;
  user_id: number;
  status: PresentationStatus;
  fixture_code: string;
  piece_technique_id: string;
  piece_technique_version_id: string;
  machine_id: string;
  gamme_id?: string | null;
  article_id?: string | null;
  receipt_id?: string | null;
  lot_id?: string | null;
  stock_movement_id?: string | null;
  reservation_id?: string | null;
  client_id: string | null;
  devis_id: number | null;
  commande_id: number | null;
  affaire_id: number | null;
  of_id: number | null;
  operation_id: string | null;
  execution_id: string | null;
};

export type PresentationActor = { id: number; role: string | null | undefined };
