export type StockReservationStatus = "ACTIVE" | "RELEASED" | "CONSUMED" | "EXPIRED" | "CANCELLED";

export type StockReservationSourceType =
  | "COMMANDE_LIGNE"
  | "OF"
  | "BON_LIVRAISON_LIGNE"
  | "AFFAIRE";

export type StockReservationListItem = {
  id: string;
  article_id: string;
  article_code: string;
  article_designation: string;
  location_id: string;
  magasin_id: string | null;
  magasin_code: string | null;
  emplacement_id: number | null;
  emplacement_code: string | null;
  lot_id: string | null;
  lot_code: string | null;
  stock_batch_id: string | null;
  qty_reserved: number;
  source_type: StockReservationSourceType;
  source_id: string;
  status: StockReservationStatus;
  reason: string | null;
  expires_at: string | null;
  released_at: string | null;
  consumed_at: string | null;
  consumed_stock_movement_id: string | null;
  row_version: number;
  correlation_id: string;
  updated_at: string;
  created_at: string;
};

export type StockReservationEvent = {
  id: string;
  event_type: "CREATED" | "UPDATED" | "RELEASED" | "CONSUMED" | "EXPIRED" | "COMPENSATED";
  old_values: unknown | null;
  new_values: unknown | null;
  actor_user_id: number;
  correlation_id: string;
  created_at: string;
};

export type StockReservationDetail = {
  reservation: StockReservationListItem;
  events: StockReservationEvent[];
};
