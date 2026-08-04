export type ReplenishmentSupplierCandidate = {
  catalogue_id: string
  supplier_id: string
  supplier_code: string | null
  supplier_name: string
  purchase_unit: string | null
  stock_unit: string | null
  stock_units_per_purchase_unit: number | null
  moq: number | null
  purchase_lot_size: number | null
  lead_time_days: number | null
  unit_price: number | null
  currency: string
  price_source: "CATALOGUE" | "HISTORICAL" | "MISSING"
  last_order_unit_price: number | null
  last_order_date: string | null
  preferred: boolean
  blockers: string[]
}

export type ReplenishmentProposal = {
  id: string
  status: "PROPOSEE" | "A_COMPLETER" | "CONVERTIE" | "RESOLUE"
  version: number
  reason_code: string
  article_id: string
  article_code: string
  article_designation: string
  stock_level_ids: string[]
  stock_level_count: number
  magasin_id: string | null
  magasin_name: string | null
  emplacement_name: string | null
  stock_unit: string | null
  qty_on_hand: number
  qty_reserved: number
  qty_available: number
  qty_open_orders: number
  minimum_stock_qty: number | null
  safety_stock_qty: number | null
  target_stock_qty: number | null
  net_requirement_qty: number
  selected_catalogue_id: string | null
  proposed_purchase_qty: number | null
  proposed_stock_qty: number | null
  unit_price: number | null
  currency: string | null
  estimated_total: number | null
  budget_status: "OK" | "EXCEEDED" | "MISSING" | "NOT_APPLICABLE"
  budget_remaining: number | null
  missing_data: string[]
  warnings: string[]
  calculation: Record<string, unknown>
  candidates: ReplenishmentSupplierCandidate[]
  commande_fournisseur_id: string | null
  commande_fournisseur_code: string | null
  last_recalculated_at: string
  updated_at: string
}

export type ReplenishmentRefreshResult = {
  items: ReplenishmentProposal[]
  refreshed: number
  resolved: number
  as_of: string
}
