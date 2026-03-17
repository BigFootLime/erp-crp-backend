export type OutilListItem = {
  id_outil: number
  id_fabricant: number | null
  id_famille: number | null
  id_geometrie: number | null
  reference_fabricant: string | null
  designation_outil_cnc: string | null
  codification: string | null
  nom_fabricant: string | null
  nom_famille: string | null
  nom_geometrie: string | null
  image: string | null
  image_path: string | null
  plan: string | null
  esquisse: string | null
  profondeur_utile?: string | null
  matiere_usiner?: string | null
  utilisation?: string | null
  longueur_coupe?: number | null
  longueur_detalonnee?: number | null
  longueur_totale?: number | null
  diametre_nominal?: number | null
  diametre_queue?: number | null
  diametre_trou?: number | null
  diametre_detalonnee?: number | null
  angle_helice?: number | null
  angle_pointe?: number | null
  angle_filetage?: number | null
  norme_filetage?: string | null
  pas_filetage?: number | null
  type_arrosage?: string | null
  type_entree?: string | null
  nombre_dents?: number | null
  quantite_stock: number
  quantite_minimale: number
}

export type OutilRelationOption = {
  id: number
  label: string
}

export type OutilValeurArete = {
  id_valeur_arete: number
  id_arete_coupe: number | null
  nom_arete_coupe: string | null
  valeur: number | null
}

export type OutilStockMovement = {
  id_mouvement: number
  type_mouvement: string | null
  quantite: number
  date_mouvement: string | null
  utilisateur: string | null
  user_id: number | null
  reason: string | null
  source: string | null
  note: string | null
  commentaire: string | null
  affaire_id: number | null
  id_fournisseur: number | null
  fournisseur_nom: string | null
  prix_unitaire: number | null
}

export type OutilPriceHistoryEntry = {
  id_historique: number
  id_outil: number | null
  id_fournisseur: number | null
  fournisseur_nom: string | null
  date_prix: string | null
  prix: number
}

export type OutilSupplierPriceSummary = {
  id_fournisseur: number
  fournisseur_nom: string
  transactions_count: number
  min_price: number | null
  max_price: number | null
  avg_price: number | null
  last_price: number | null
  last_price_date: string | null
}

export type OutilPricingResponse = {
  history: OutilPriceHistoryEntry[]
  supplier_summary: OutilSupplierPriceSummary[]
  replenishments: OutilStockMovement[]
}

export type OutilDetail = OutilListItem & {
  fournisseurs: OutilRelationOption[]
  revetements: OutilRelationOption[]
  valeurs_aretes: OutilValeurArete[]
  recent_movements: OutilStockMovement[]
}
