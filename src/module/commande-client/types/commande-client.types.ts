// Commande (en-tête)
export type Commande = {
  id: string
  numero: string
  designation: string | null
  client_id: string
  contact_id: string | null
  destinataire_id: string | null
  emetteur: string | null
  code_client: string | null
  date_commande: string
  arc_edi: boolean
  arc_date_envoi: string | null
  compteur_affaire_id: string | null
  type_affaire: "fabrication" | "previsionnel" | "regroupement"
  mode_port_id: string | null
  mode_reglement_id: string | null
  commentaire: string | null
  remise_globale: number
  total_ht: number
  total_ttc: number
  created_at: string
  updated_at: string
}

// Lignes
export type CommandeLigne = {
  id: string
  commande_id: string
  designation: string
  code_piece: string | null
  quantite: number
  unite: string | null
  prix_unitaire_ht: number
  remise_ligne: number
  taux_tva: number
  delai_client: string | null
  delai_interne: string | null
  total_ht: number
  total_ttc: number
  devis_numero: string | null
  famille: string | null
}

// Echéances
export type CommandeEcheance = {
  id: string
  commande_id: string
  libelle: string
  date_echeance: string
  pourcentage: number
  montant: number
}

// Pièces/Opérations/Achats
export type CommandePiece = {
  id: string
  commande_id: string
  source_piece_id: string | null
  code_piece: string | null
  designation: string
  rang: number
  parent_id: string | null
  plan: string | null
  coef: number
  article_id: string | null
}

export type CommandeOperation = {
  id: string
  commande_id: string
  piece_id: string
  phase: number
  designation: string
  poste_id: string | null
  coef: number
  tp: number
  tf_unit: number
  qte: number
  taux_horaire: number
  temps_total: number
  cout_mo: number
}

export type CommandeAchat = {
  id: string
  commande_id: string
  piece_id: string
  article_id: string | null
  designation: string
  fournisseur_id: string | null
  qte: number
  unite: string | null
  pu_achat: number
  tva_achat: number
  total_achat_ht: number
  total_achat_ttc: number
}

// Documents
export type CommandeDocument = {
  id: string
  commande_id: string
  filename: string
  path: string
  mimetype: string | null
  size: number | null
}

// Input global reçu du front (champ "data" JSON)
export type CreateCommandeInput = {
  numero: string
  designation?: string | null
  client_id: string
  contact_id?: string | null
  destinataire_id?: string | null
  emetteur?: string | null
  code_client?: string | null
  date_commande: string
  arc_edi?: boolean
  arc_date_envoi?: string | null
  compteur_affaire_id?: string | null
  type_affaire?: "fabrication" | "previsionnel" | "regroupement"
  mode_port_id?: string | null
  mode_reglement_id?: string | null
  commentaire?: string | null
  remise_globale?: number
  total_ht?: number
  total_ttc?: number

  lignes: Array<Omit<CommandeLigne,"id"|"commande_id">>
  echeancier?: Array<Omit<CommandeEcheance,"id"|"commande_id">>

 pieces: Array<Omit<CommandePiece,"commande_id">>
  operations?: Array<Omit<CommandeOperation,"id"|"commande_id">>
  achats?: Array<Omit<CommandeAchat,"id"|"commande_id">>
}
