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
  description: string;
  quantite: number;
  unite: string | null;
  prix_unitaire_ht: number;
  remise_ligne: number;
  taux_tva: number;
  total_ht: number;
  total_ttc: number;
};

export type DevisHeader = {
  id: number;
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
