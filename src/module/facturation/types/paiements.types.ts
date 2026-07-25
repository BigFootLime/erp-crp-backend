import type { ClientLite } from "./shared.types";

export type FactureLite = {
  id: number;
  numero: string;
  client_id: string;
};

// #126 — Statuts portes par la base depuis le patch #227 :
// contraintes `paiement_status_227_ck` et `paiement_workflow_status_227_ck`.
export const PAIEMENT_STATUSES = [
  "UNALLOCATED",
  "PARTIALLY_ALLOCATED",
  "ALLOCATED",
  "REJECTED",
  "REVERSED",
] as const;
export type PaiementStatus = (typeof PAIEMENT_STATUSES)[number];

export const PAIEMENT_WORKFLOW_STATUSES = ["RECORDED", "ALLOCATED", "REVERSED"] as const;
export type PaiementWorkflowStatus = (typeof PAIEMENT_WORKFLOW_STATUSES)[number];

export type Paiement = {
  id: number;
  /** Nullable : un reglement enregistre n'est pas encore forcement affecte a une facture. */
  facture_id: number | null;
  client_id: string;
  date_paiement: string;
  montant: number;
  mode: string | null;
  reference: string | null;
  commentaire: string | null;
  status: string | null;
  workflow_status: string | null;
  created_at: string;
  updated_at: string;
  facture?: FactureLite | null;
  client?: ClientLite | null;
};

export type PaiementListItem = {
  id: number;
  /** Nullable : voir `Paiement.facture_id`. */
  facture_id: number | null;
  client_id: string;
  date_paiement: string;
  montant: number;
  mode: string | null;
  reference: string | null;
  status: string | null;
  workflow_status: string | null;
  updated_at: string;
  facture?: FactureLite | null;
  client?: ClientLite | null;
};

export type Paginated<T> = { items: T[]; total: number };
