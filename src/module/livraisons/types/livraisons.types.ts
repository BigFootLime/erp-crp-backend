export type Paginated<T> = {
  items: T[]
  total: number
}

export type BonLivraisonListSummary = {
  total: number
  draft: number
  ready: number
  shipped: number
  delivered: number
  cancelled: number
}

export type BonLivraisonStatut = "DRAFT" | "READY" | "SHIPPED" | "DELIVERED" | "CANCELLED"

export type UploadedDocument = {
  originalname: string
  path: string
  mimetype: string
  size: number
}

export type UserLite = {
  id: number
  username: string
  name: string | null
  surname: string | null
  label: string
}

export type ClientLite = {
  client_id: string
  company_name: string
}

export type CommandeLite = {
  id: number
  numero: string
} | null

export type AffaireLite = {
  id: number
  reference: string
} | null

export type AdresseLivraisonLite = {
  id: string
  name: string | null
  street: string | null
  house_number: string | null
  postal_code: string | null
  city: string | null
  country: string | null
  label: string
} | null

export type BonLivraisonListItem = {
  id: string
  numero: string
  statut: BonLivraisonStatut
  client: ClientLite
  commande: CommandeLite
  affaire: AffaireLite
  date_creation: string
  date_expedition: string | null
  date_livraison: string | null
  transporteur: string | null
  tracking_number: string | null
  updated_at: string
}

export type BonLivraisonHeader = {
  id: string
  numero: string
  statut: BonLivraisonStatut
  client: ClientLite
  commande: CommandeLite
  affaire: AffaireLite
  adresse_livraison: AdresseLivraisonLite
  date_creation: string
  date_expedition: string | null
  date_livraison: string | null
  transporteur: string | null
  tracking_number: string | null
  commentaire_interne: string | null
  commentaire_client: string | null
  reception_nom_signataire: string | null
  reception_date_signature: string | null
  row_version: number
  created_at: string
  updated_at: string
  created_by: UserLite | null
  updated_by: UserLite | null
}

export type BonLivraisonLigne = {
  id: string
  bon_livraison_id: string
  ordre: number
  designation: string
  code_piece: string | null
  quantite: number
  unite: string | null
  commande_ligne_id: number | null
  delai_client: string | null
  allocations: BonLivraisonLigneAllocation[]
  created_at: string
  updated_at: string
  created_by: UserLite | null
  updated_by: UserLite | null
}

export type BonLivraisonLigneAllocation = {
  id: string
  bon_livraison_ligne_id: string
  article_id: string
  lot_id: string | null
  lot_code: string | null
  lot_status: string | null
  magasin_id: string | null
  magasin_code: string | null
  emplacement_id: number | null
  emplacement_code: string | null
  location_id: string | null
  stock_level_id: string | null
  stock_batch_id: string | null
  reservation_id: string | null
  reservation_status: string | null
  stock_movement_line_id: string | null
  quantite: number
  unite: string | null
  created_at: string
  updated_at: string
  created_by: UserLite | null
  updated_by: UserLite | null
}

export type BonLivraisonProofType =
  | "RECIPIENT_ACK"
  | "CARRIER_DOCUMENT"
  | "PHOTO"
  | "EXTERNAL_SIGNATURE"

export type BonLivraisonDeliveryProof = {
  id: string
  bon_livraison_id: string
  proof_type: BonLivraisonProofType
  delivered_at: string
  received_by_name: string | null
  document_id: string | null
  document_name: string | null
  note: string | null
  correlation_id: string
  created_by: UserLite | null
  created_at: string
}

export type BonLivraisonDocument = {
  id: string
  bon_livraison_id: string
  document_id: string
  type: string | null
  version: number
  created_at: string
  uploaded_by: UserLite | null
  document_name: string | null
  document_type: string | null
  checksum_sha256: string | null
  file_size_bytes: number | null
  mime_type: string | null
}

export type BonLivraisonEventLog = {
  id: string
  bon_livraison_id: string
  event_type: string
  old_values: unknown | null
  new_values: unknown | null
  user: UserLite | null
  created_at: string
}

export type BonLivraisonDetail = {
  bon_livraison: BonLivraisonHeader
  lignes: BonLivraisonLigne[]
  documents: BonLivraisonDocument[]
  proofs: BonLivraisonDeliveryProof[]
  events: BonLivraisonEventLog[]
}

export type ShipmentPreviewBlocker = {
  code: string
  message: string
  line_id?: string
  allocation_id?: string
}

export type ShipmentPreviewAllocation = {
  allocation_id: string
  line_id: string
  line_order: number
  article_id: string
  lot_id: string | null
  magasin_id: string
  emplacement_id: number
  location_id: string
  stock_level_id: string
  stock_batch_id: string | null
  reservation_id: string | null
  quantity: number
  unit: string | null
  quantity_available: number
}

export type ShipmentPreviewRemainder = {
  line_id: string
  commande_ligne_id: number | null
  quantity_ordered: number | null
  quantity_already_shipped: number | null
  quantity_remaining_before_shipment: number | null
  quantity_in_shipment: number
  quantity_remaining_after_shipment: number | null
}

export type ShipmentPreviewMovement = {
  movement_type: "OUT"
  article_id: string
  lot_id: string | null
  magasin_id: string
  emplacement_id: number
  stock_level_id: string
  stock_batch_id: string | null
  quantity: number
  unit: string | null
}

export type ShipmentPreviewPack = {
  version_id: string
  version: number
  checksum_sha256: string
}

export type BonLivraisonShipmentPreview = {
  bon_livraison_id: string
  numero: string
  status: BonLivraisonStatut
  row_version: number
  preview_hash: string
  can_ship: boolean
  blockers: ShipmentPreviewBlocker[]
  allocations: ShipmentPreviewAllocation[]
  reliquats: ShipmentPreviewRemainder[]
  simulated_movements: ShipmentPreviewMovement[]
  document_pack: ShipmentPreviewPack | null
  totals: {
    lines: number
    allocations: number
    quantity: number
  }
}

export type BonLivraisonShipResult = {
  id: string
  statut: "SHIPPED"
  row_version: number
  stock_movement_ids: string[]
  correlation_id: string
  idempotent_replay: boolean
  billing_event: "DELIVERY.SHIPPED"
  invoice_created: false
}
