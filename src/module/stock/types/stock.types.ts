export type Paginated<T> = {
  items: T[];
  total: number;
};

export type ArticleType = "PIECE_TECHNIQUE" | "PURCHASED";

export type StockArticleListItem = {
  id: number;
  code: string;
  designation: string;
  article_type: ArticleType;
  piece_technique_id: string | null;
  piece_code: string | null;
  piece_designation: string | null;
  unite: string | null;
  lot_tracking: boolean;
  is_active: boolean;
  updated_at: string;
  created_at: string;
};

export type StockArticleDetail = StockArticleListItem & {
  notes: string | null;
};

export type StockArticleKpis = {
  total: number;
  active: number;
  lot_tracked: number;
  piece_technique: number;
  purchased: number;
};

export type StockMagasinListItem = {
  id: number;
  code: string;
  name: string;
  is_active: boolean;
  updated_at: string;
  created_at: string;
  emplacements_count: number;
  scrap_emplacements_count: number;
};

export type StockMagasinDetail = {
  magasin: {
    id: number;
    code: string;
    name: string;
    is_active: boolean;
    notes: string | null;
    updated_at: string;
    created_at: string;
  };
  emplacements: StockEmplacementListItem[];
};

export type StockMagasinKpis = {
  magasins_total: number;
  magasins_active: number;
  emplacements_total: number;
  emplacements_scrap: number;
};

export type StockEmplacementListItem = {
  id: number;
  magasin_id: number;
  magasin_code: string;
  magasin_name: string;
  code: string;
  name: string | null;
  is_scrap: boolean;
  is_active: boolean;
  updated_at: string;
  created_at: string;
};

export type StockLotListItem = {
  id: number;
  article_id: number;
  article_code: string;
  article_designation: string;
  lot_code: string;
  supplier_lot_code: string | null;
  received_at: string | null;
  manufactured_at: string | null;
  expiry_at: string | null;
  updated_at: string;
  created_at: string;
};

export type StockLotDetail = StockLotListItem & {
  notes: string | null;
};

export type StockBalanceRow = {
  article_id: number;
  article_code: string;
  article_designation: string;
  magasin_id: number;
  magasin_code: string;
  magasin_name: string;
  emplacement_id: number;
  emplacement_code: string;
  emplacement_name: string | null;
  lot_id: number | null;
  lot_code: string | null;
  qty_on_hand: number;
  updated_at: string;
};

export type StockMovementType = "IN" | "OUT" | "TRANSFER" | "ADJUSTMENT" | "SCRAP";
export type StockMovementStatus = "DRAFT" | "POSTED" | "CANCELLED";

export type StockMovementListItem = {
  id: number;
  movement_no: string;
  movement_type: StockMovementType;
  status: StockMovementStatus;
  effective_at: string;
  posted_at: string | null;
  source_document_type: string | null;
  source_document_id: string | null;
  reason_code: string | null;
  updated_at: string;
  created_at: string;
  lines_count: number;
  qty_total: number;
};

export type StockMovementLineDetail = {
  id: number;
  movement_id: number;
  line_no: number;
  article_id: number;
  article_code: string;
  article_designation: string;
  lot_id: number | null;
  lot_code: string | null;
  qty: number;
  unite: string | null;
  unit_cost: number | null;
  currency: string | null;
  src_magasin_id: number | null;
  src_magasin_code: string | null;
  src_magasin_name: string | null;
  src_emplacement_id: number | null;
  src_emplacement_code: string | null;
  src_emplacement_name: string | null;
  dst_magasin_id: number | null;
  dst_magasin_code: string | null;
  dst_magasin_name: string | null;
  dst_emplacement_id: number | null;
  dst_emplacement_code: string | null;
  dst_emplacement_name: string | null;
  note: string | null;
};

export type StockDocument = {
  document_id: string;
  document_name: string;
  type: string | null;
};

export type StockMovementEvent = {
  id: number;
  stock_movement_id: number;
  event_type: string;
  old_values: unknown | null;
  new_values: unknown | null;
  user_id: number | null;
  created_at: string;
};

export type StockMovementDetail = {
  movement: {
    id: number;
    movement_no: string;
    movement_type: StockMovementType;
    status: StockMovementStatus;
    effective_at: string;
    posted_at: string | null;
    source_document_type: string | null;
    source_document_id: string | null;
    reason_code: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
    created_by: number | null;
    updated_by: number | null;
    posted_by: number | null;
  };
  lines: StockMovementLineDetail[];
  documents: StockDocument[];
  events: StockMovementEvent[];
};

export type StockMovementKpis = {
  movements_total: number;
  movements_posted: number;
  movements_draft: number;
  qty_in_30d: number;
  qty_out_30d: number;
};
