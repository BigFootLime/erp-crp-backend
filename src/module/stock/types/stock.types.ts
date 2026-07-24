export type Paginated<T> = {
  items: T[];
  total: number;
};

export type ArticleType = "PIECE_TECHNIQUE" | "PURCHASED";
export type ArticleCategory = "fabrique" | "matiere" | "traitement" | "achat";
export type ArticleBusinessCategory =
  | "matiere_premiere"
  | "traitement_surface"
  | "achat_revente"
  | "achat_transforme"
  | "sous_traitance"
  | "piece_finie_fabriquee";
export type ArticleWorkflowStatus = "EN_DEVIS" | "VALIDE";

export type StockArticleCategoryOption = {
  code: ArticleBusinessCategory;
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

export type StockMatiereNuance = {
  id: number;
  code: string;
  designation: string;
  densite: number | null;
  is_active: boolean;
  etat_ids: number[];
};

export type StockMatiereEtat = {
  id: number;
  code: string;
  designation: string;
  unite_achat: number;
  is_active: boolean;
  nuance_ids: number[];
};

export type StockMatiereSousEtat = {
  id: number;
  etat_id: number;
  code: string;
  designation: string;
  is_active: boolean;
};

export type ArticleMatierePayload = {
  nuance_id?: number | null;
  etat_id?: number | null;
  sous_etat_id?: number | null;
  barre_a_decouper?: boolean;
  longueur_mm?: number | null;
  longueur_unitaire_mm?: number | null;
  largeur_mm?: number | null;
  hauteur_mm?: number | null;
  epaisseur_mm?: number | null;
  diametre_mm?: number | null;
  largeur_plat_mm?: number | null;
};

export type ArticleTechnicalVersion = {
  id: string;
  indice: string;
  statut: string;
  plan_reference: string | null;
  date_application: string | null;
};

export type ArticleProcurementProfile = {
  manufacturer_name: string | null;
  manufacturer_reference: string | null;
  preferred_catalogue_id: string | null;
  packaging: string | null;
  process: string | null;
  finish: string | null;
  requirements: string | null;
  certificate_required: boolean;
  min_stock: number | null;
  max_stock: number | null;
};

export type ArticleSupplierReference = {
  catalogue_id: string;
  supplier_id: string;
  supplier_code: string | null;
  supplier_name: string;
  supplier_reference: string | null;
  unit: string | null;
  unit_price: number | null;
  currency: string | null;
  lead_time_days: number | null;
  moq: number | null;
  conditions: string | null;
  preferred: boolean;
  active: boolean;
};

export type StockArticleListItem = {
  id: string;
  root_article_id: string;
  parent_article_id: string | null;
  version_number: number;
  plan_index: number;
  status: ArticleWorkflowStatus;
  projet_id: number | null;
  code: string;
  designation: string;
  designation_secondary: string | null;
  article_type: ArticleType;
  article_category: ArticleCategory;
  article_categories: ArticleBusinessCategory[];
  family_code: string;
  stock_managed: boolean;
  piece_technique_id: string | null;
  piece_code: string | null;
  piece_designation: string | null;
  unite: string | null;
  lot_tracking: boolean;
  is_sold: boolean;
  is_active: boolean;
  row_version: number;
  archived_at: string | null;
  archive_reason: string | null;
  applicable_version: ArticleTechnicalVersion | null;
  qty_available: number;
  qty_reserved: number;
  qty_total: number;
  locations_count: number;
  updated_at: string;
  created_at: string;
};

export type StockArticleDetail = StockArticleListItem & {
  notes: string | null;
  article_matiere: ArticleMatierePayload | null;
  procurement: ArticleProcurementProfile | null;
  suppliers: ArticleSupplierReference[];
  documents: StockDocument[];
  costs_redacted: boolean;
};

export type ArticleWhereUsedType =
  | "PIECE_CURRENT"
  | "PIECE_HISTORICAL"
  | "QUOTE"
  | "CUSTOMER_ORDER"
  | "SUPPLIER_ORDER"
  | "WORK_ORDER"
  | "RECEIPT"
  | "LOT"
  | "STOCK_MOVEMENT"
  | "DELIVERY";

export type ArticleWhereUsedItem = {
  usage_type: ArticleWhereUsedType;
  usage_id: string;
  parent_id: string | null;
  label: string;
  occurred_at: string | null;
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
  location_type: "RECEIVING" | "PRODUCTION" | "QUARANTINE" | "SCRAP" | "SHIPPING" | "STORAGE";
  allow_inbound: boolean;
  allow_outbound: boolean;
  restrictions: Record<string, unknown>;
  updated_at: string;
  created_at: string;
};

export type StockLotListItem = {
  id: string;
  article_id: string;
  article_code: string;
  article_designation: string;
  lot_code: string;
  lot_status: "LIBERE" | "EN_ATTENTE" | "QUARANTAINE" | "BLOQUE";
  lot_status_note: string | null;
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

export type StockLotGenealogyEdge = {
  id: string;
  parent_lot_id: string;
  parent_lot_code: string;
  parent_article_id: string;
  parent_article_code: string;
  child_lot_id: string;
  child_lot_code: string;
  child_article_id: string;
  child_article_code: string;
  operation_type: "SPLIT" | "MERGE" | "TRANSFORM";
  qty_contributed: number;
  unit_code: string;
  stock_movement_id: string | null;
  correlation_id: string;
  created_at: string;
};

export type StockLotGenealogy = {
  lot: StockLotDetail;
  ancestors: StockLotGenealogyEdge[];
  descendants: StockLotGenealogyEdge[];
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
  qty_depreciated: number;
  qty_quarantine: number;
  qty_blocked: number;
  qty_available: number;
  qty_scrap_recorded: number;
  lot_status: "LIBERE" | "EN_ATTENTE" | "QUARANTAINE" | "BLOQUE" | null;
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
  correlation_id: string | null;
  reversal_of_id: string | null;
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
  revision?: string | null;
  version?: number;
  mime_type?: string;
  size_bytes?: number;
  sha256?: string | null;
  uploaded_by?: number | null;
  created_at?: string;
  updated_at?: string;
  is_active?: boolean;
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
    correlation_id: string | null;
    reversal_of_id: string | null;
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

export type StockMovementCompensationPreview = {
  original_movement_id: string;
  original_movement_no: string | null;
  compensable: boolean;
  blockers: Array<{ code: string; message: string }>;
  proposed_movement: {
    movement_type: StockMovementType;
    source_document_type: "STOCK_COMPENSATION";
    source_document_id: string;
    reason_code: "COMPENSATION";
    notes: string;
    lines: Array<{
      article_id: string;
      lot_id: string | null;
      qty: number;
      unite: string | null;
      src_magasin_id: string | null;
      src_emplacement_id: number | null;
      dst_magasin_id: string | null;
      dst_emplacement_id: number | null;
      direction?: "IN" | "OUT";
    }>;
  } | null;
};

export type StockMovementImpactPreview = {
  authoritative: true;
  as_of: string;
  movement_type: StockMovementType;
  qty_total: number;
  can_post: boolean;
  blockers: Array<{ code: string; message: string }>;
  impacts: Array<{
    side: "SOURCE" | "DESTINATION";
    magasin_id: string;
    emplacement_id: number;
    lot_id: string | null;
    before: {
      qty_on_hand: number;
      qty_reserved: number;
      qty_depreciated: number;
      qty_quarantine: number;
      qty_blocked: number;
      qty_available: number;
    };
    after: {
      qty_on_hand: number;
      qty_reserved: number;
      qty_depreciated: number;
      qty_quarantine: number;
      qty_blocked: number;
      qty_available: number;
    };
  }>;
};

export type StockMovementKpis = {
  movements_total: number;
  movements_posted: number;
  movements_draft: number;
  qty_in_30d: number;
  qty_out_30d: number;
};

export type StockAnalytics = {
  authoritative: true;
  as_of: string;
  scope: {
    magasin_id: string | null;
    from: string | null;
    to: string | null;
  };
  kpis: {
    articles_count: number;
    stock_managed_articles: number;
    qty_on_hand: number;
    qty_available: number;
    qty_reserved: number;
    ruptures_count: number;
    below_minimum_count: number;
    at_risk_reservations_count: number;
    quarantine_lots_count: number;
    active_inventory_count: number;
    discrepancies_to_review_count: number;
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

export type StockInventorySessionStatus = "DRAFT" | "OPEN" | "APPROVED" | "CLOSED" | "CANCELLED";

export type StockInventorySessionListItem = {
  id: string;
  session_no: string;
  status: StockInventorySessionStatus;
  scope_magasin_id: string | null;
  scope_emplacement_id: number | null;
  scope_article_id: string | null;
  scope_article_category: ArticleCategory | null;
  blind_count: boolean;
  requires_second_count: boolean;
  snapshot_at: string | null;
  approved_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  row_version: number;
  correlation_id: string | null;
  started_at: string | null;
  closed_at: string | null;
  notes: string | null;
  updated_at: string;
  created_at: string;
  adjustment_movements_count: number;
  last_adjustment_movement_id: string | null;
};

export type StockInventorySessionLine = {
  id: string;
  snapshot_line_id: string;
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
  counted_qty: number | null;
  qty_on_hand: number | null;
  delta_qty: number | null;
  count_round: 1 | 2 | null;
  reason_code: string | null;
  note: string | null;
  updated_at: string;
  created_at: string;
};

export type StockInventorySessionDetail = {
  session: StockInventorySessionListItem;
  lines: StockInventorySessionLine[];
  adjustment_movement_ids: string[];
};
