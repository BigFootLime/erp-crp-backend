import type { BonLivraisonDocument, BonLivraisonHeader, BonLivraisonLigneAllocation, BonLivraisonLigne, UserLite } from "./livraisons.types"

export type LivraisonPackCheck = {
  allocations_ok: boolean
  shipped_or_ready: boolean
  stock_link_ok: boolean
  missing: string[]
}

export type LivraisonPackStockMovement = {
  id: string
  movement_no: string | null
  movement_type: string
  status: string
  effective_at: string | null
  posted_at: string | null
}

export type LivraisonPackAllocation = BonLivraisonLigneAllocation & {
  article: {
    code: string | null
    designation: string | null
  }
  lot: {
    lot_code: string
  } | null
}

export type LivraisonPackLine = Omit<BonLivraisonLigne, "allocations"> & {
  allocations: LivraisonPackAllocation[]
}

export type LivraisonPackVersionStatus = "GENERATED" | "REVOKED"

export type LivraisonPackVersion = {
  id: string
  bon_livraison_id: string
  version: number
  status: LivraisonPackVersionStatus
  generated_at: string
  generated_by: UserLite | null
  bl_pdf_document: {
    bon_livraison_document_id: string
    document_id: string
    document_name: string | null
  } | null
  cofc_pdf_document: {
    bon_livraison_document_id: string
    document_id: string
    document_name: string | null
  } | null
  checksum_sha256: string | null
}

export type LivraisonPackPreview = {
  bon_livraison: BonLivraisonHeader
  lignes: LivraisonPackLine[]
  stock_movements: LivraisonPackStockMovement[]
  documents_attached: BonLivraisonDocument[]
  documents_generated: BonLivraisonDocument[]
  pack_versions: LivraisonPackVersion[]
  checks: LivraisonPackCheck
}

export type LivraisonPackGenerateResult = {
  pack_version_id: string
  version: number
  bl_document_id: string
  cofc_document_id: string
}
