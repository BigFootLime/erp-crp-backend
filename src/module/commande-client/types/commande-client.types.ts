export type CommandeClientRow = {
  id: string;
  numero: string;
  client_id: string;
  contact_id: string | null;
  destinataire_id: string | null;
  emetteur: string | null;
  code_client: string | null;
  date_commande: string;
  arc_edi: boolean;
  arc_date_envoi: string | null;
  compteur_affaire_id: string | null;
  type_affaire: "fabrication" | "previsionnel" | "regroupement";
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
  statut: string | null;
};

export type ClientLite = {
  client_id: string;
  company_name: string;
  email: string | null;
  phone: string | null;
  delivery_address_id: string | null;
  bill_address_id: string | null;
};

export type CommandeListItem = Pick<
  CommandeClientRow,
  "id" | "numero" | "client_id" | "date_commande" | "total_ttc" | "updated_at" | "statut" | "total_ht"
> & {
  client?: ClientLite | null;
};

export type CommandeLigneRow = {
  id: string;
  commande_id: string;
  designation: string;
  code_piece: string | null;
  quantite: string;
  unite: string | null;
  prix_unitaire_ht: string;
  remise_ligne: string | null;
  taux_tva: string | null;
  delai_client: string | null;
  delai_interne: string | null;
  total_ht: string;
  total_ttc: string;
  devis_numero: string | null;
  famille: string | null;
};

export type CommandeEcheanceRow = {
  id: string;
  commande_id: string;
  libelle: string;
  date_echeance: string;
  pourcentage: string;
  montant: string;
};

export type DocumentRow = {
  id: string;
  doc_code: string | null;
  title: string | null;
  file_path: string;
  mime_type: string | null;
  version_index: string | null;
  kind: string | null;
  created_at: string;
};

export type CommandeDocumentRow = {
  id: string;
  commande_id: string;
  document_id: string;
  type: string | null;
  document: DocumentRow;
};

export type CommandeHistoriqueRow = {
  id: string;
  commande_id: string;
  user_id: number | null;
  date_action: string;
  ancien_statut: string | null;
  nouveau_statut: string;
  commentaire: string | null;
};

export type AffaireRow = {
  id: string;
  reference: string;
  client_id: string;
  commande_id: string | null;
  devis_id: string | null;
  type_affaire: "fabrication" | "previsionnel" | "regroupement";
  statut: string;
  date_ouverture: string;
  date_cloture: string | null;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
};

export type CommandeToAffaireRow = {
  id: string;
  commande_id: string;
  affaire_id: string;
  date_conversion: string;
  commentaire: string | null;
};

export type CommandeAffaireRow = CommandeToAffaireRow & { affaire: AffaireRow };

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
  numero: string;
  client_id: string;
  date_commande?: string;
  contact_id?: string | null;
  destinataire_id?: string | null;
  emetteur?: string | null;
  code_client?: string | null;
  arc_edi?: boolean;
  arc_date_envoi?: string | null;
  compteur_affaire_id?: string | null;
  type_affaire?: "fabrication" | "previsionnel" | "regroupement";
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

export type UploadedDocument = {
  originalname: string;
  path: string;
  mimetype: string;
};
