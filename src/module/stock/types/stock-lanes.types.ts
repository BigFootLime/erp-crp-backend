import type { StockLane, StockLaneLocationFacts } from "../domain/stock-lanes";

export type StockLaneLocation = {
  location_id: string;
  emplacement_id: number;
  emplacement_code: string;
  magasin_id: string;
  magasin_code: string;
  lane: StockLane | null;
  version: number;
  facts: StockLaneLocationFacts;
  choices: Array<{ value: StockLane; label: string; blockers: string[] }>;
};

export type StockLanePosition = {
  position_id: string;
  stock_level_id: string;
  stock_batch_id: string | null;
  location_id: string;
  lane: StockLane | null;
  magasin_code: string | null;
  emplacement_code: string | null;
  article_id: string;
  article_code: string;
  designation: string;
  unit: string;
  lot_id: string | null;
  lot_code: string | null;
  lot_status: string | null;
  source_scope: string;
  physical_qty: string;
  reserved_qty: string;
  delivery_reserved_qty: string;
  assembly_reserved_qty: string;
  other_reserved_qty: string;
  unreserved_qty: string;
  available_by_lot_status_qty: string;
  unexplained_reserved_qty: string;
};
