import type { ClientLite } from "./shared.types";

export type TarificationClient = {
  id: number;
  client_id: string;
  remise_globale_pct: number;
  escompte_pct: number;
  delai_paiement_jours: number | null;
  taux_tva_default: number;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
  client?: ClientLite | null;
};

export type TarificationClientListItem = {
  id: number;
  client_id: string;
  remise_globale_pct: number;
  escompte_pct: number;
  delai_paiement_jours: number | null;
  taux_tva_default: number;
  valid_from: string | null;
  valid_to: string | null;
  updated_at: string;
  client?: ClientLite | null;
};

export type Paginated<T> = { items: T[]; total: number };
