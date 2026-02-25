export type Paginated<T> = {
  items: T[];
  total: number;
};

export type UserLite = {
  id: number;
  username: string;
  name: string | null;
  surname: string | null;
  label: string;
};

export type MetrologieCriticite = "NORMAL" | "CRITIQUE";
export type MetrologieEquipementStatut = "ACTIF" | "INACTIF" | "REBUT";
export type MetrologiePlanStatut = "EN_COURS" | "SUSPENDU" | "EN_RETARD" | "HORS_TOLERANCE";
export type MetrologieCertificatResultat = "CONFORME" | "NON_CONFORME" | "AJUSTAGE";

export type MetrologieEquipement = {
  id: string;
  code: string | null;
  designation: string;
  categorie: string | null;
  marque: string | null;
  modele: string | null;
  numero_serie: string | null;
  localisation: string | null;
  criticite: MetrologieCriticite;
  statut: MetrologieEquipementStatut;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: UserLite | null;
  updated_by: UserLite | null;
};

export type MetrologiePlan = {
  id: string;
  equipement_id: string;
  periodicite_mois: number;
  last_done_date: string | null;
  next_due_date: string | null;
  statut: MetrologiePlanStatut;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
  created_by: UserLite | null;
  updated_by: UserLite | null;
};

export type MetrologieCertificat = {
  id: string;
  equipement_id: string;
  date_etalonnage: string;
  date_echeance: string | null;
  resultat: MetrologieCertificatResultat;
  organisme: string | null;
  commentaire: string | null;
  file_original_name: string | null;
  storage_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  created_at: string;
  updated_at: string;
  created_by: UserLite | null;
  updated_by: UserLite | null;
};

export type MetrologieEventLog = {
  id: string;
  equipement_id: string | null;
  event_type: string;
  old_values: unknown | null;
  new_values: unknown | null;
  user: UserLite | null;
  created_at: string;
};

export type MetrologieEquipementListItem = {
  id: string;
  code: string | null;
  designation: string;
  localisation: string | null;
  criticite: MetrologieCriticite;
  statut: MetrologieEquipementStatut;
  last_done_date: string | null;
  next_due_date: string | null;
  is_overdue: boolean;
  updated_at: string;
  created_at: string;
};

export type MetrologieEquipementDetail = {
  equipement: MetrologieEquipement;
  plan: MetrologiePlan | null;
  certificats: MetrologieCertificat[];
  events: MetrologieEventLog[];
};

export type MetrologieKpis = {
  kpis: {
    total: number;
    actifs: number;
    critiques: number;
    en_retard: number;
    en_retard_critiques: number;
    echeance_30j: number;
  };
};

export type MetrologieAlertItem = {
  id: string;
  code: string | null;
  designation: string;
  localisation: string | null;
  criticite: MetrologieCriticite;
  next_due_date: string;
  days_overdue: number;
};

export type MetrologieAlerts = {
  overdue_critical: MetrologieAlertItem[];
  overdue_critical_count: number;
};

export type MetrologieAlertsSummary = {
  overdue_count: number;
  due_soon_count: number;
  oot_count: number;
};
