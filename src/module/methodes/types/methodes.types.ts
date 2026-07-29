// Contrats de sortie du module Méthodes.
//
// Règle de franchise (SOUL.md, ADR-0020 §6) : une valeur inconnue sort en
// `null`, jamais en `0`. Un centre de frais sans tarif ne renvoie donc pas
// « 0,00 €/h » mais `taux_horaire: null` accompagné de `taux_statut: 'ABSENT'`.

export type AuditContext = {
  user_id: number;
  role: string | null;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

export type MachineFamilyDTO = {
  code: string;
  libelle: string;
  description: string | null;
  programme_requis: boolean;
  est_favori: boolean;
  ordre_affichage: number;
  actif: boolean;
  /** Nombre de machines non archivées rattachées à la famille. */
  machines_count: number;
  created_at: string;
  updated_at: string;
};

export type CostCenterRateDTO = {
  id: string;
  cf_id: string;
  taux_horaire: number;
  devise: string;
  date_effet: string;
  date_fin: string | null;
  source: string;
  commentaire: string | null;
  superseded_at: string | null;
  superseded_by: string | null;
  created_at: string;
  created_by: number | null;
  /** `true` pour le tarif applicable à la date de la requête. */
  en_vigueur: boolean;
};

export type CostCenterDTO = {
  id: string;
  code: string;
  designation: string;
  type_cf: string | null;
  section: string | null;
  machine_family_code: string | null;
  machine_family_libelle: string | null;
  statut: string;
  devise: string;
  designation_auto: boolean;
  designation_modele: string | null;
  commentaire: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string | null;
  /** Tarif applicable aujourd'hui. `null` = aucun tarif : ce n'est pas 0 €/h. */
  taux_horaire: number | null;
  taux_statut: "CENTRE_FRAIS" | "ABSENT";
  taux_date_effet: string | null;
  taux_id: string | null;
  /** Nombre de tarifs historisés, tarif courant inclus. */
  taux_historique_count: number;
  machines_count: number;
};

export type MachineOptionDTO = {
  id: string;
  code: string;
  name: string;
  display_name: string | null;
  machine_family_code: string | null;
  machine_family_libelle: string | null;
  cf_id: string | null;
  cf_code: string | null;
  status: string;
  is_available: boolean;
  valid_from: string | null;
  valid_to: string | null;
  /** `true` si la machine peut être posée sur une NOUVELLE opération. */
  selectable: boolean;
  /** Raison lisible quand `selectable` vaut `false`. */
  unselectable_reason: string | null;
};
