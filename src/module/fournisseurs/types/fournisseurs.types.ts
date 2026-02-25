export type Paginated<T> = {
  items: T[]
  total: number
}

export type Fournisseur = {
  id: string
  code: string
  nom: string
  actif: boolean
  tva: string | null
  siret: string | null
  email: string | null
  telephone: string | null
  site_web: string | null
  notes: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

export type FournisseurListItem = Pick<Fournisseur, "id" | "code" | "nom" | "actif" | "updated_at">

export type FournisseurContact = {
  id: string
  fournisseur_id: string
  nom: string
  email: string | null
  telephone: string | null
  role: string | null
  notes: string | null
  actif: boolean
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

export type FournisseurCatalogueType =
  | "MATIERE"
  | "CONSOMMABLE"
  | "SOUS_TRAITANCE"
  | "SERVICE"
  | "OUTILLAGE"
  | "AUTRE"

export type FournisseurCatalogueItem = {
  id: string
  fournisseur_id: string
  type: FournisseurCatalogueType
  article_id: string | null
  designation: string
  reference_fournisseur: string | null
  unite: string | null
  prix_unitaire: number | null
  devise: string | null
  delai_jours: number | null
  moq: number | null
  conditions: string | null
  actif: boolean
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

export type FournisseurDocument = {
  id: string
  fournisseur_id: string
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
