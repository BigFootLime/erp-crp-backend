export type AsBuiltLotHeader = {
  id: string
  article_id: string
  article_code: string
  article_designation: string
  lot_code: string
  supplier_lot_code: string | null
  received_at: string | null
  manufactured_at: string | null
  expiry_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export type AsBuiltOfLite = {
  id: number
  numero: string
  statut: string
  priority: string | null
  affaire_id: number | null
  commande_id: number | null
  piece_technique_id: string
  piece_code: string
  piece_designation: string
  quantite_lancee: number
  quantite_bonne: number
  quantite_rebut: number
}

export type AsBuiltBonLivraisonLite = {
  id: string
  numero: string
  statut: string
  date_creation: string | null
  date_livraison: string | null
  transporteur: string | null
  tracking_number: string | null
  reception_nom_signataire: string | null
  reception_date_signature: string | null
  commande_id: number | null
  affaire_id: number | null
}

export type AsBuiltNonConformityLite = {
  id: string
  reference: string
  status: string
  severity: string
  detection_date: string
  due_date: string | null
  description: string
}

export type AsBuiltPackVersion = {
  id: string
  lot_fg_id: string
  version: number
  status: "GENERATED" | "REVOKED"
  generated_at: string
  generated_by: { id: number; username: string; name: string | null; surname: string | null; label: string } | null
  signataire_user_id: number | null
  commentaire: string | null
  pdf_document_id: string | null
  pdf_document_name: string | null
}

export type AsBuiltPreview = {
  lot: AsBuiltLotHeader
  ofs: AsBuiltOfLite[]
  bon_livraisons: AsBuiltBonLivraisonLite[]
  non_conformities: AsBuiltNonConformityLite[]
  pack_versions: AsBuiltPackVersion[]
  checks: {
    open_non_conformities: number
    overdue_non_conformities: number
    has_of_link: boolean
    has_shipping_link: boolean
  }
}

export type AsBuiltGenerateResult = {
  asbuilt_version_id: string
  version: number
  pdf_document_id: string
}
