export type Paginated<T> = {
  items: T[]
  total: number
}

export type FournisseurStatus = "actif" | "a_completer" | "inactif" | "archive"

export type FournisseurDomaine = {
  id: string
  code: string
  label: string
  description: string | null
  icon: string | null
  sort_order: number
  is_active: boolean
}

export type FournisseurDomaineLien = FournisseurDomaine & {
  is_primary: boolean
  notes: string | null
}

export type FournisseurRelations = {
  outillage: {
    id_fournisseur: number
    outils_count: number
    fabricants_count: number
    prix_count: number
    mouvements_count: number
  } | null
}

export type Fournisseur = {
  id: string
  code: string
  nom: string
  actif: boolean
  status: FournisseurStatus
  type_principal: string | null
  tva: string | null
  siret: string | null
  email: string | null
  telephone: string | null
  site_web: string | null
  adresse_ligne: string | null
  house_no: string | null
  postcode: string | null
  city: string | null
  country: string | null
  nom_commercial: string | null
  logo: string | null
  notes: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
  domaines: FournisseurDomaineLien[]
  relations: FournisseurRelations
  adresses: FournisseurAdresse[]
  homologation: FournisseurHomologationSummary | null
  contacts_count: number
  catalogue_count: number
  documents_count: number
  events_count: number
  adresses_count: number
  homologations_count: number
}

export type FournisseurListItem = Pick<
  Fournisseur,
  | "id"
  | "code"
  | "nom"
  | "actif"
  | "status"
  | "type_principal"
  | "email"
  | "telephone"
  | "city"
  | "country"
  | "logo"
  | "updated_at"
  | "domaines"
  | "relations"
  | "homologation"
  | "contacts_count"
  | "catalogue_count"
  | "documents_count"
  | "events_count"
  | "adresses_count"
  | "homologations_count"
>

export type FournisseurContact = {
  id: string
  fournisseur_id: string
  nom: string
  first_name: string | null
  last_name: string | null
  full_name: string | null
  email: string | null
  telephone: string | null
  mobile: string | null
  role: string | null
  notes: string | null
  is_primary: boolean
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
  incoterm: string | null
  prix_multiple: number | null
  valid_from: string | null
  valid_to: string | null
  exigence_qualite: string | null
  requiert_controle_reception: boolean
  actif: boolean
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

export type FournisseurCataloguePrixHistory = {
  id: string
  catalogue_id: string
  prix_unitaire: number | null
  devise: string | null
  delai_jours: number | null
  moq: number | null
  valid_from: string | null
  recorded_at: string
  recorded_by: number | null
}

export type FournisseurAdresseType = "commande" | "livraison" | "facturation"

export type FournisseurAdresse = {
  id: string
  fournisseur_id: string
  type: FournisseurAdresseType
  label: string | null
  ligne1: string | null
  ligne2: string | null
  house_no: string | null
  postcode: string | null
  city: string | null
  country: string | null
  is_primary: boolean
  actif: boolean
  notes: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

export type FournisseurHomologationStatut =
  | "a_qualifier"
  | "en_cours"
  | "homologue"
  | "sous_reserve"
  | "suspendu"
  | "refuse"
  | "expire"

export type FournisseurHomologation = {
  id: string
  fournisseur_id: string
  domaine_code: string | null
  statut: FournisseurHomologationStatut
  reference: string | null
  organisme: string | null
  perimetre: string | null
  valid_from: string | null
  valid_to: string | null
  document_id: string | null
  version: number
  is_current: boolean
  notes: string | null
  created_at: string
  updated_at: string
  created_by: number | null
  updated_by: number | null
}

export type FournisseurHomologationSummary = {
  statut: FournisseurHomologationStatut
  valid_to: string | null
  domaine_code: string | null
}

// Client-facing DTO: storage_path and stored_name are intentionally NOT exposed.
export type FournisseurDocument = {
  id: string
  fournisseur_id: string
  document_type: string
  commentaire: string | null
  original_name: string
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

export type FournisseurEvent = {
  id: string
  fournisseur_id: string
  event_type: string
  title: string
  description: string | null
  metadata: Record<string, unknown>
  created_by: number | null
  created_at: string
}
