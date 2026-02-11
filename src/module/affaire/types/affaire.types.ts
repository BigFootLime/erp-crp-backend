export type ClientLite = {
  client_id: string;
  company_name: string;
  email: string | null;
  phone: string | null;
  delivery_address_id: string | null;
  bill_address_id: string | null;
};

export type CommandeHeaderLite = {
  id: number;
  numero: string;
  client_id: string;
  date_commande: string;
  total_ht: number;
  total_ttc: number;
  updated_at: string;
  statut: string;
};

export type DevisHeaderLite = {
  id: number;
  numero: string;
  client_id: string;
  date_creation: string;
  date_validite: string | null;
  statut: string;
  total_ht: number;
  total_ttc: number;
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
  client?: ClientLite | null;
  commande?: CommandeHeaderLite | null;
  devis?: DevisHeaderLite | null;
};

export type AffaireListItem = Omit<Affaire, "commande" | "devis">;

export type AffaireUpsertPayload = {
  reference?: string;
  client_id?: string;
  commande_id?: number | null;
  devis_id?: number | null;
  type_affaire?: string;
  statut?: string;
  date_ouverture?: string;
  date_cloture?: string | null;
  commentaire?: string | null;
};
