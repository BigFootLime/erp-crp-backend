// src/module/pieces-techniques/types/pieces-techniques.types.ts

export type BomLine = {
  id?: string
  child_piece_technique_id: string
  rang: number
  quantite: number
  repere?: string | null
  designation?: string | null
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
  article_id?: string | null
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

  article_id: string | null
  client_id: string | null
  created_by: number | null
  updated_by: number | null

  famille_id: string
  name_piece: string
  code_piece: string
  designation: string
  designation_2: string | null
  prix_unitaire: number
  en_fabrication: boolean
  cycle: number | null
  cycle_fabrication: number | null
  code_client: string | null
  client_name: string | null
  ensemble: boolean

  bom: BomLine[]
  operations: Operation[]
  achats: Achat[]
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
  en_fabrication: boolean
  cycle?: number | null
  cycle_fabrication?: number | null
  code_client?: string | null
  client_name?: string | null
  ensemble: boolean

  bom: BomLine[]
  operations: Operation[]
  achats: Achat[]
}
