export type Paginated<T> = {
  items: T[]
  total: number
}

export type ReceptionFournisseurStatus = "OPEN" | "CLOSED" | "CANCELLED"

export type LotStatus = "LIBERE" | "BLOQUE" | "EN_ATTENTE" | "QUARANTAINE"

export type IncomingInspectionStatus = "IN_PROGRESS" | "DECIDED"

export type IncomingInspectionDecision = "LIBERE" | "BLOQUE"

export type ReceptionFournisseur = {
  id: string
  reception_no: string
  fournisseur_id: string
  status: string
  reception_date: string
  supplier_reference: string | null
  commentaire: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

export type ReceptionFournisseurListItem = {
  id: string
  reception_no: string
  fournisseur_id: string
  fournisseur_code: string
  fournisseur_nom: string
  status: string
  reception_date: string
  supplier_reference: string | null
  lines_count: number
  pending_lines_count: number
  blocked_lines_count: number
  updated_at: string
}

export type ReceptionFournisseurLine = {
  id: string
  reception_id: string
  line_no: number
  article_id: string
  article_code: string | null
  article_designation: string | null
  designation: string | null
  qty_received: number
  unite: string | null
  supplier_lot_code: string | null
  lot_id: string | null
  lot_code: string | null
  lot_status: string | null
  inspection_status: string | null
  inspection_decision: string | null
  notes: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

export type ReceptionFournisseurDocument = {
  id: string
  reception_id: string
  reception_line_id: string | null
  document_type: string
  commentaire: string | null
  original_name: string
  stored_name: string
  storage_path: string
  mime_type: string
  size_bytes: number
  sha256: string | null
  label: string | null
  uploaded_by: number | null
  removed_at: string | null
  removed_by: number | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

export type ReceptionIncomingInspection = {
  id: string
  reception_id: string
  reception_line_id: string
  lot_id: string
  status: string
  decision: string | null
  decision_note: string | null
  started_at: string
  decided_at: string | null
  decided_by: number | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
  measurements: ReceptionIncomingMeasurement[]
}

export type ReceptionIncomingMeasurement = {
  id: string
  inspection_id: string
  characteristic: string
  nominal_value: number | null
  tolerance_min: number | null
  tolerance_max: number | null
  measured_value: number | null
  unit: string | null
  result: string | null
  comment: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

export type ReceptionStockReceipt = {
  id: string
  reception_id: string
  reception_line_id: string
  stock_movement_id: string
  qty: number
  created_at: string
  created_by: number | null
}

export type ReceptionKpis = {
  total: number
  open: number
  pending_inspection: number
  blocked_lots: number
}

export type ReceptionFournisseurDetail = {
  reception: ReceptionFournisseur
  lines: ReceptionFournisseurLine[]
  documents: ReceptionFournisseurDocument[]
  inspections: ReceptionIncomingInspection[]
  stock_receipts: ReceptionStockReceipt[]
}
