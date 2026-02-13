export type Paginated<T> = {
  items: T[]
  total: number
}

export type BonLivraisonStatut = "DRAFT" | "READY" | "SHIPPED" | "DELIVERED" | "CANCELLED"

export type UploadedDocument = {
  originalname: string
  path: string
  mimetype: string
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
  id: number
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
  id: number
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
  created_at: string
  updated_at: string
  created_by: UserLite | null
  updated_by: UserLite | null
}

export type BonLivraisonLigne = {
  id: number
  bon_livraison_id: number
  ordre: number
  designation: string
  code_piece: string | null
  quantite: number
  unite: string | null
  commande_ligne_id: number | null
  delai_client: string | null
  created_at: string
  updated_at: string
  created_by: UserLite | null
  updated_by: UserLite | null
}

export type BonLivraisonDocument = {
  id: number
  bon_livraison_id: number
  document_id: string
  type: string | null
  version: number
  created_at: string
  uploaded_by: UserLite | null
  document_name: string | null
  document_type: string | null
}

export type BonLivraisonEventLog = {
  id: number
  bon_livraison_id: number
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
  events: BonLivraisonEventLog[]
}
