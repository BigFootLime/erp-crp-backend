export type ClientLite = {
  client_id: string;
  company_name: string;
  email: string | null;
  phone: string | null;
  delivery_address_id: string | null;
  bill_address_id: string | null;
};

export type DocumentClient = {
  id: string;
  document_name: string;
  type: string | null;
  creation_date: string;
  created_by: string | null;
};

export type DevisDocument = {
  id: number;
  devis_id: number;
  document_id: string;
  type: string | null;
  document: DocumentClient | null;
};

export type DevisLine = {
  id: number;
  devis_id: number;
  article_id: string | null;
  piece_technique_id: string | null;
  source_article_devis_id?: string | null;
  source_dossier_devis_id?: string | null;
  code_piece: string | null;
  description: string;
  quantite: number;
  unite: string | null;
  prix_unitaire_ht: number;
  remise_ligne: number;
  taux_tva: number;
  total_ht: number;
  total_ttc: number;
  article_devis?: ArticleDevis | null;
  dossier_technique_piece_devis?: DossierTechniquePieceDevis | null;
};

export type ArticleDevis = {
  id: string;
  devis_id: number;
  devis_ligne_id: number | null;
  root_article_devis_id: string;
  parent_article_devis_id: string | null;
  version_number: number;
  code: string;
  designation: string;
  primary_category: string;
  article_categories: string[];
  family_code: string;
  plan_index: number;
  projet_id: number | null;
  source_official_article_id: string | null;
  created_at: string;
  updated_at: string;
};

export type DossierTechniquePieceDevis = {
  id: string;
  article_devis_id: string;
  devis_id: number;
  root_dossier_devis_id: string;
  parent_dossier_devis_id: string | null;
  version_number: number;
  code_piece: string;
  designation: string;
  source_official_piece_technique_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type DevisHeader = {
  id: number;
  root_devis_id: number;
  parent_devis_id: number | null;
  version_number: number;
  numero: string;
  client_id: string;
  contact_id: string | null;
  user_id: number;
  adresse_facturation_id: string | null;
  adresse_livraison_id: string | null;
  mode_reglement_id: string | null;
  compte_vente_id: string | null;
  date_creation: string;
  date_validite: string | null;
  statut: string;
  remise_globale: number;
  total_ht: number;
  total_ttc: number;
  commentaires: string | null;
  conditions_paiement_id: number | null;
  biller_id: string | null;
  updated_at?: string | null;
  client?: ClientLite | null;
};

export type DevisListItem = Pick<
  DevisHeader,
  | "id"
  | "root_devis_id"
  | "parent_devis_id"
  | "version_number"
  | "numero"
  | "client_id"
  | "date_creation"
  | "date_validite"
  | "statut"
  | "total_ht"
  | "total_ttc"
  | "remise_globale"
  | "updated_at"
> & {
  client?: ClientLite | null;
};

export type UploadedDocument = {
  originalname: string;
  path: string;
  mimetype: string;
};
