export type Paginated<T> = {
  items: T[];
  total: number;
};

export type ArticleType = "PIECE_TECHNIQUE" | "PURCHASED";
export type ArticleCategory = "fabrique" | "matiere" | "traitement" | "achat";

export type StockArticleCategoryOption = {
  code: ArticleCategory;
  label: string;
  code_segment: string;
  stock_managed_default: boolean;
  piece_technique_required: boolean;
  commande_client_selectable: boolean;
};

export type StockArticleFamily = {
  code: string;
  designation: string;
  category: ArticleCategory;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
};

export type StockArticleListItem = {
  id: string;
  code: string;
  designation: string;
  article_type: ArticleType;
  article_category: ArticleCategory;
  family_code: string;
  stock_managed: boolean;
  piece_technique_id: string | null;
  piece_code: string | null;
  piece_designation: string | null;
  unite: string | null;
  lot_tracking: boolean;
  is_active: boolean;
  qty_available: number;
  qty_reserved: number;
  qty_total: number;
  locations_count: number;
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
  stock_managed: number;
  fabricated: number;
  purchased: number;
  matiere: number;
  treatment: number;
  achat: number;
};

export type StockMagasinListItem = {
  id: string;
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
    id: string;
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
  magasin_id: string;
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
  id: string;
  article_id: string;
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

// This endpoint now reflects stock_levels (via v_stock_current).
export type StockBalanceRow = {
  article_id: string;
  article_code: string;
  article_designation: string;
  magasin_id: string | null;
  magasin_code: string | null;
  magasin_name: string | null;
  emplacement_id: number | null;
  emplacement_code: string | null;
  emplacement_name: string | null;
  lot_id: string | null;
  lot_code: string | null;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  location_id: string;
  location_code: string;
  location_description: string | null;
  unit_id: string;
  unit_code: string;
  managed_in_stock: boolean;
  qty_on_hand: number;
  qty_reserved: number;
  qty_available: number;
  updated_at: string;
};

export type StockMovementType =
  | "IN"
  | "OUT"
  | "TRANSFER"
  | "ADJUST"
  | "RESERVE"
  | "UNRESERVE"
  | "DEPRECIATE"
  | "ADJUSTMENT"
  | "SCRAP";

export type StockMovementStatus = "DRAFT" | "POSTED" | "CANCELLED";

export type StockMovementListItem = {
  id: string;
  movement_no: string | null;
  movement_type: StockMovementType;
  status: StockMovementStatus;
  article_id: string;
  article_code: string;
  article_designation: string;
  qty_total: number;
  effective_at: string;
  posted_at: string | null;
  source_document_type: string | null;
  source_document_id: string | null;
  reason_code: string | null;
  updated_at: string;
  created_at: string;
  lines_count: number;
};

export type StockMovementLineDetail = {
  id: string;
  movement_id: string;
  line_no: number;
  article_id: string;
  article_code: string;
  article_designation: string;
  lot_id: string | null;
  lot_code: string | null;
  qty: number;
  unite: string | null;
  unit_cost: number | null;
  currency: string | null;
  src_magasin_id: string | null;
  src_magasin_code: string | null;
  src_magasin_name: string | null;
  src_emplacement_id: number | null;
  src_emplacement_code: string | null;
  src_emplacement_name: string | null;
  dst_magasin_id: string | null;
  dst_magasin_code: string | null;
  dst_magasin_name: string | null;
  dst_emplacement_id: number | null;
  dst_emplacement_code: string | null;
  dst_emplacement_name: string | null;
  note: string | null;
  direction: "IN" | "OUT" | null;
};

export type StockDocument = {
  document_id: string;
  document_name: string;
  type: string | null;
};

export type StockMovementEvent = {
  id: string;
  stock_movement_id: string;
  event_type: string;
  old_values: unknown | null;
  new_values: unknown | null;
  user_id: number | null;
  created_at: string;
};

export type StockMovementDetail = {
  movement: {
    id: string;
    movement_no: string | null;
    movement_type: StockMovementType;
    status: StockMovementStatus;
    article_id: string;
    stock_level_id: string;
    stock_batch_id: string | null;
    qty: number;
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

export type StockAnalytics = {
  kpis: {
    articles_count: number;
    stock_managed_articles: number;
    qty_on_hand: number;
    qty_available: number;
    qty_reserved: number;
  };
  magasins: Array<{
    id: string;
    code: string;
    name: string;
  }>;
  category_counts: Array<{
    article_category: ArticleCategory;
    articles_count: number;
    stock_managed_count: number;
  }>;
  series: {
    net_by_date: Array<{
      date: string;
      qty_in: number;
      qty_out: number;
      net_qty: number;
    }>;
    top_articles: Array<{
      article_id: string;
      code: string;
      designation: string;
      qty_moved: number;
      qty_on_hand: number;
      qty_available: number;
    }>;
  };
};

export type StockInventorySessionStatus = "OPEN" | "CLOSED";

export type StockInventorySessionListItem = {
  id: string;
  session_no: string;
  status: StockInventorySessionStatus;
  started_at: string;
  closed_at: string | null;
  notes: string | null;
  updated_at: string;
  created_at: string;
  adjustment_movements_count: number;
  last_adjustment_movement_id: string | null;
};

export type StockInventorySessionLine = {
  id: string;
  session_id: string;
  line_no: number;
  article_id: string;
  article_code: string;
  article_designation: string;
  magasin_id: string;
  magasin_code: string;
  magasin_name: string;
  emplacement_id: number;
  emplacement_code: string;
  emplacement_name: string | null;
  lot_id: string | null;
  lot_code: string | null;
  counted_qty: number;
  qty_on_hand: number;
  delta_qty: number;
  note: string | null;
  updated_at: string;
  created_at: string;
};

export type StockInventorySessionDetail = {
  session: StockInventorySessionListItem;
  lines: StockInventorySessionLine[];
  adjustment_movement_ids: string[];
};
