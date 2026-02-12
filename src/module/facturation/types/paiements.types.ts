import type { ClientLite } from "./shared.types";

export type FactureLite = {
  id: number;
  numero: string;
  client_id: string;
};

export type Paiement = {
  id: number;
  facture_id: number;
  client_id: string;
  date_paiement: string;
  montant: number;
  mode: string | null;
  reference: string | null;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
  facture?: FactureLite | null;
  client?: ClientLite | null;
};

export type PaiementListItem = {
  id: number;
  facture_id: number;
  client_id: string;
  date_paiement: string;
  montant: number;
  mode: string | null;
  reference: string | null;
  updated_at: string;
  facture?: FactureLite | null;
  client?: ClientLite | null;
};

export type Paginated<T> = { items: T[]; total: number };
