import type { ClientLite, DocumentClient } from "./shared.types";

export type FactureLite = {
  id: number;
  numero: string;
};

export type AvoirHeader = {
  id: number;
  numero: string;
  client_id: string;
  facture_id: number | null;
  date_emission: string;
  statut: string;
  motif: string | null;
  total_ht: number;
  total_ttc: number;
  created_at: string;
  updated_at: string;
  client?: ClientLite | null;
  facture?: FactureLite | null;
};

export type AvoirLine = {
  id: number;
  avoir_id: number;
  ordre: number;
  designation: string;
  code_piece: string | null;
  quantite: number;
  unite: string | null;
  prix_unitaire_ht: number;
  remise_ligne: number;
  taux_tva: number;
  total_ht: number;
  total_ttc: number;
};

export type AvoirDocument = {
  id: number;
  avoir_id: number;
  document_id: string;
  type: string | null;
  created_at: string;
  document: DocumentClient | null;
};

export type AvoirDetail = {
  avoir: AvoirHeader;
  lignes: AvoirLine[];
  documents: AvoirDocument[];
};

export type AvoirListItem = {
  id: number;
  numero: string;
  client_id: string;
  facture_id: number | null;
  date_emission: string;
  total_ht: number;
  total_ttc: number;
  updated_at: string;
  statut: string;
  client?: ClientLite | null;
  facture?: FactureLite | null;
};

export type Paginated<T> = { items: T[]; total: number };
