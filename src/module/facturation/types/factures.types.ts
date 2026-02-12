import type { ClientLite, DocumentClient } from "./shared.types";

export type FactureHeader = {
  id: number;
  numero: string;
  client_id: string;
  devis_id: number | null;
  commande_id: number | null;
  affaire_id: number | null;
  date_emission: string;
  date_echeance: string | null;
  statut: string;
  remise_globale: number;
  total_ht: number;
  total_ttc: number;
  commentaires: string | null;
  created_at: string;
  updated_at: string;
  total_paye_ttc?: number;
  total_avoirs_ttc?: number;
  reste_a_payer_ttc?: number;
  client?: ClientLite | null;
};

export type FactureLine = {
  id: number;
  facture_id: number;
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

export type FactureDocument = {
  id: number;
  facture_id: number;
  document_id: string;
  type: string | null;
  created_at: string;
  document: DocumentClient | null;
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
};

export type FactureDetail = {
  facture: FactureHeader;
  lignes: FactureLine[];
  documents: FactureDocument[];
  paiements: Paiement[];
};

export type FactureListItem = {
  id: number;
  numero: string;
  client_id: string;
  date_emission: string;
  date_echeance: string | null;
  total_ht: number;
  total_ttc: number;
  updated_at: string;
  statut: string;
  client?: ClientLite | null;
  total_paye_ttc?: number;
  total_avoirs_ttc?: number;
  reste_a_payer_ttc?: number;
};

export type Paginated<T> = { items: T[]; total: number };
