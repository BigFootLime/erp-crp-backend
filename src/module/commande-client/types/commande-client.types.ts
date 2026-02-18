export type ClientLite = {
  client_id: string;
  company_name: string;
  email: string | null;
  phone: string | null;
  delivery_address_id: string | null;
  bill_address_id: string | null;
};

export type CommandeOrderType = "FERME" | "CADRE" | "INTERNE";

export type CadreReleaseStatus = "PLANNED" | "SENT" | "CONFIRMED" | "DELIVERED" | "CANCELLED";

export type CommandeClient = {
  id: number;
  numero: string;
  client_id: string | null;
  contact_id: string | null;
  destinataire_id: string | null;
  adresse_facturation_id: string | null;
  emetteur: string | null;
  code_client: string | null;
  date_commande: string;
  arc_edi: boolean;
  arc_date_envoi: string | null;
  compteur_affaire_id: string | null;
  type_affaire: string;
  order_type: CommandeOrderType;
  cadre_start_date: string | null;
  cadre_end_date: string | null;
  dest_stock_magasin_id: number | null;
  dest_stock_emplacement_id: number | null;
  mode_port_id: string | null;
  mode_reglement_id: string | null;
  conditions_paiement_id: number | null;
  biller_id: string | null;
  compte_vente_id: string | null;
  commentaire: string | null;
  remise_globale: number;
  total_ht: number;
  total_ttc: number;
  created_at: string;
  updated_at: string;
  statut: string;
};

export type CommandeListItem = Pick<
  CommandeClient,
  | "id"
  | "numero"
  | "client_id"
  | "order_type"
  | "date_commande"
  | "total_ttc"
  | "updated_at"
  | "statut"
  | "total_ht"
> & {
  client?: ClientLite | null;
};

export type CommandeCadreRelease = {
  id: number;
  commande_cadre_id: number;
  numero_release: string;
  date_demande: string;
  date_livraison_prevue: string | null;
  statut: CadreReleaseStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  updated_by: number | null;
};

export type CommandeCadreReleaseLine = {
  id: number;
  release_id: number;
  ordre: number;
  commande_ligne_id: number | null;
  designation: string;
  code_piece: string | null;
  quantite: number;
  unite: string | null;
  delai_client: string | null;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  updated_by: number | null;
};

export type CommandeClientLine = {
  id: number;
  commande_id: number;
  designation: string;
  code_piece: string | null;
  quantite: number;
  unite: string | null;
  prix_unitaire_ht: number;
  remise_ligne: number | null;
  taux_tva: number | null;
  delai_client: string | null;
  delai_interne: string | null;
  total_ht: number;
  total_ttc: number;
  devis_numero: string | null;
  famille: string | null;
};

export type CommandeEcheance = {
  id: number;
  commande_id: number;
  libelle: string;
  date_echeance: string;
  pourcentage: number;
  montant: number;
};

export type DocumentClient = {
  id: string;
  document_name: string;
  type?: string | null;
  creation_date?: string | null;
  created_by?: string | null;
};

export type CommandeDocument = {
  id: number;
  commande_id: number;
  document_id: string;
  type?: string | null;
  document?: DocumentClient | null;
};

export type CommandeHistorique = {
  id: number;
  commande_id: number;
  user_id: number | null;
  date_action: string;
  ancien_statut: string | null;
  nouveau_statut: string;
  commentaire: string | null;
};

export type Affaire = {
  id: number;
  reference: string;
  client_id: string;
  commande_id: number | null;
  devis_id: number | null;
  type_affaire: string;
  statut: string;
  date_ouverture: string;
  date_cloture: string | null;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
};

export type CommandeToAffaire = {
  id: number;
  commande_id: number;
  affaire_id: number;
  date_conversion: string;
  commentaire: string | null;
  affaire?: Affaire;
};

export type CommandeLigneInput = {
  designation: string;
  code_piece?: string | null;
  quantite: number;
  unite?: string | null;
  prix_unitaire_ht: number;
  remise_ligne?: number | null;
  taux_tva?: number | null;
  delai_client?: string | null;
  delai_interne?: string | null;
  devis_numero?: string | null;
  famille?: string | null;
};

export type CommandeEcheanceInput = {
  libelle: string;
  date_echeance: string;
  pourcentage: number;
  montant: number;
};

export type CreateCommandeInput = {
  numero?: string;
  client_id?: string | null;
  date_commande?: string;
  contact_id?: string | null;
  destinataire_id?: string | null;
  adresse_facturation_id?: string | null;
  emetteur?: string | null;
  code_client?: string | null;
  arc_edi?: boolean;
  arc_date_envoi?: string | null;
  compteur_affaire_id?: string | null;
  type_affaire?: string;
  order_type?: CommandeOrderType;
  cadre_start_date?: string | null;
  cadre_end_date?: string | null;
  dest_stock_magasin_id?: number | null;
  dest_stock_emplacement_id?: number | null;
  mode_port_id?: string | null;
  mode_reglement_id?: string | null;
  conditions_paiement_id?: number | null;
  biller_id?: string | null;
  compte_vente_id?: string | null;
  commentaire?: string | null;
  remise_globale?: number;
  total_ht?: number;
  total_ttc?: number;
  lignes: CommandeLigneInput[];
  echeances?: CommandeEcheanceInput[];
};

export type CreateCadreReleaseInput = {
  date_demande?: string;
  date_livraison_prevue?: string | null;
  statut?: CadreReleaseStatus;
  notes?: string | null;
  lignes?: Array<{
    ordre?: number;
    commande_ligne_id?: number | null;
    designation: string;
    code_piece?: string | null;
    quantite: number;
    unite?: string | null;
    delai_client?: string | null;
  }>;
};

export type UpdateCadreReleasePatch = {
  date_demande?: string;
  date_livraison_prevue?: string | null;
  statut?: CadreReleaseStatus;
  notes?: string | null;
};

export type CreateCadreReleaseLineInput = {
  ordre?: number;
  commande_ligne_id?: number | null;
  designation: string;
  code_piece?: string | null;
  quantite: number;
  unite?: string | null;
  delai_client?: string | null;
};

export type UpdateCadreReleaseLinePatch = {
  ordre?: number;
  commande_ligne_id?: number | null;
  designation?: string;
  code_piece?: string | null;
  quantite?: number;
  unite?: string | null;
  delai_client?: string | null;
};

export type UploadedDocument = {
  originalname: string;
  path: string;
  mimetype: string;
};
