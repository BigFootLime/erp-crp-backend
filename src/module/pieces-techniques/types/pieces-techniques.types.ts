// src/module/pieces-techniques/types/pieces-techniques.types.ts

export type BomLine = {
  id?: string
  child_piece_id: string
  rang: number
  quantite: number
  repere?: string | null
  designation?: string | null
}

export type PieceTechniqueStatut = "DRAFT" | "ACTIVE" | "IN_FABRICATION" | "OBSOLETE"

export type PieceTechniqueHistoryEntry = {
  id: string
  date_action: string
  user_id: number | null
  ancien_statut: PieceTechniqueStatut | null
  nouveau_statut: PieceTechniqueStatut
  commentaire: string | null
}

export type Operation = {
  id?: string
  phase: number
  designation: string
  designation_2?: string | null
  cf_id?: string | null
  prix: number
  coef: number
  tp: number
  tf_unit: number
  qte: number
  taux_horaire: number
  temps_total: number
  cout_mo: number
}

export type Achat = {
  id?: string
  phase?: number | null
  famille_piece_id?: string | null
  nom?: string | null
  fournisseur_id?: string | null
  fournisseur_nom?: string | null
  fournisseur_code?: string | null
  quantite: number
  quantite_brut_mm?: number | null
  longueur_mm?: number | null
  coefficient_chute?: number | null
  quantite_pieces?: number | null
  prix_par_quantite?: number | null
  tarif?: number | null
  prix?: number | null
  unite_prix?: string | null
  pu_achat?: number | null
  tva_achat?: number | null
  total_achat_ht?: number | null
  total_achat_ttc?: number | null
  designation?: string | null
  designation_2?: string | null
  designation_3?: string | null
}

export type PieceTechnique = {
  id: string
  created_at: string
  updated_at: string

  client_id: string | null
  created_by: number | null
  updated_by: number | null

  famille_id: string
  name_piece: string
  code_piece: string
  designation: string
  designation_2: string | null
  prix_unitaire: number
  statut: PieceTechniqueStatut
  en_fabrication: boolean
  cycle: number | null
  cycle_fabrication: number | null
  code_client: string | null
  client_name: string | null
  ensemble: boolean

  bom: BomLine[]
  operations: Operation[]
  achats: Achat[]

  history?: PieceTechniqueHistoryEntry[]
}

// Payload envoyé par le front
export type CreatePieceTechniqueInput = {
  article_id?: string | null
  client_id?: string | null
  created_by?: number | null
  updated_by?: number | null

  famille_id: string
  name_piece: string
  code_piece: string
  designation: string
  designation_2?: string | null
  prix_unitaire: number
  statut?: PieceTechniqueStatut
  en_fabrication?: boolean
  cycle?: number | null
  cycle_fabrication?: number | null
  code_client?: string | null
  client_name?: string | null
  ensemble: boolean

  bom: BomLine[]
  operations: Operation[]
  achats: Achat[]
}

export type PieceTechniqueListItem = Pick<
  PieceTechnique,
  "id" | "code_piece" | "designation" | "designation_2" | "client_id" | "client_name" | "famille_id" | "statut" | "en_fabrication" | "prix_unitaire" | "created_at" | "updated_at"
> & {
  bom_count: number
  operations_count: number
  achats_count: number
  cout_mo_total: number
  achats_total_ht: number
}

export type Paginated<T> = {
  items: T[]
  total: number
}

export type PiecesTechniquesStats = {
  total: number
  active: number
  in_fabrication: number
  obsolete: number
}
