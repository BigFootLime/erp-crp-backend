// DTO de la surface Métrologie 360 (#229).
//
// Règle de sécurité : AUCUN de ces types ne porte `storage_path`, chemin local,
// bucket, jeton, signature ou binaire. Un document se lit uniquement par son
// endpoint authentifié `/metrologie/v2/equipements/:id/certificats/:childId/file`.
//
// Les DTO de LISTE, de DÉTAIL et d'ACTION sont distincts : une liste ne charge
// jamais la charge utile d'un détail, et une action ne renvoie jamais plus que
// ce que l'appelant a le droit de voir.

import type {
  MetrologyEligibilityCode,
  EligibilitySeverity,
  MetrologyInstrumentSnapshot,
} from "../domain/metrology-eligibility";
import type {
  MetrologyEquipmentState,
  MetrologyImpactDecision,
  MetrologyImpactStatus,
  MetrologyOperationType,
  MetrologyVerdict,
} from "../domain/metrology-policy";
import type { DueStatus } from "../domain/metrology-schedule";

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type UserRef = {
  id: number;
  username: string;
  label: string;
};

/* -------------------------------------------------------------------------- */
/* Référentiel                                                                */
/* -------------------------------------------------------------------------- */

export type MetrologyCategoryDTO = {
  code: string;
  parent_code: string | null;
  label: string;
  description: string | null;
  version: number;
  active: boolean;
  display_order: number;
  requires_range: boolean;
  requires_resolution: boolean;
  requires_uncertainty: boolean;
  requires_unit: boolean;
  default_unit: string | null;
  default_periodicity_months: number | null;
  default_operation_type: "ETALONNAGE" | "VERIFICATION";
  in_use: boolean;
};

/* -------------------------------------------------------------------------- */
/* Équipement                                                                 */
/* -------------------------------------------------------------------------- */

export type MetrologyEquipmentListItemDTO = {
  id: string;
  code: string | null;
  designation: string;
  categorie_code: string | null;
  categorie_label: string | null;
  etat: MetrologyEquipmentState;
  /** État affiché : `etat` enrichi de DUE_SOON / OVERDUE calculés serveur. */
  etat_effectif: string;
  criticite: "NORMAL" | "CRITIQUE";
  site: string | null;
  zone: string | null;
  localisation_precise: string | null;
  numero_serie: string | null;
  next_due_date: string | null;
  due_status: DueStatus;
  days_overdue: number;
  days_remaining: number | null;
  open_impact_count: number;
  updated_at: string;
};

export type MetrologyEquipmentSpecificationsDTO = {
  unite: string | null;
  plage_min: number | null;
  plage_max: number | null;
  resolution: number | null;
  mpe: number | null;
  incertitude: number | null;
  methodes: string[];
  conditions_utilisation: string | null;
  restrictions: string | null;
  etalon_reference: string | null;
  exige_certificat: boolean;
  specifications: Record<string, unknown>;
};

export type MetrologyEquipmentDTO = MetrologyEquipmentSpecificationsDTO & {
  id: string;
  code: string | null;
  designation: string;
  categorie_code: string | null;
  categorie_label: string | null;
  sous_categorie_code: string | null;
  marque: string | null;
  modele: string | null;
  numero_serie: string | null;
  criticite: "NORMAL" | "CRITIQUE";
  etat: MetrologyEquipmentState;
  etat_effectif: string;
  etat_motif: string | null;
  etat_changed_at: string | null;
  statut_legacy: string;
  proprietaire_service: string | null;
  responsable: UserRef | null;
  site: string | null;
  magasin: string | null;
  zone: string | null;
  localisation_precise: string | null;
  date_mise_en_service: string | null;
  date_retrait: string | null;
  quarantine_reason: string | null;
  quarantined_at: string | null;
  last_conforme_at: string | null;
  last_conforme_execution_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: UserRef | null;
  updated_by: UserRef | null;
};

export type MetrologyDueDTO = {
  status: DueStatus;
  next_due_date: string | null;
  days_remaining: number | null;
  days_overdue: number;
};

export type MetrologyPlanVersionDTO = {
  id: string;
  equipement_id: string;
  version: number;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  operation_type: "ETALONNAGE" | "VERIFICATION";
  methode: string | null;
  procedure_ref: string | null;
  periodicite_valeur: number;
  periodicite_unite: "DAY" | "WEEK" | "MONTH" | "YEAR";
  base_calcul: "LAST_PROOF" | "FIXED_DATE";
  alert_window_days: number;
  tolerance_min: number | null;
  tolerance_max: number | null;
  unite: string | null;
  min_points: number | null;
  prestataire_type: "INTERNE" | "EXTERNE";
  prestataire_label: string | null;
  fournisseur_id: string | null;
  role_habilite: string | null;
  criticite: "NORMAL" | "CRITIQUE";
  blocking_strategy: "BLOCK" | "WARN" | "NONE";
  exige_certificat: boolean;
  effective_from: string | null;
  last_proof_date: string | null;
  last_proof_execution_id: string | null;
  next_due_date: string | null;
  due: MetrologyDueDTO;
  notes: string | null;
  published_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MetrologyEquipmentDetailDTO = {
  equipement: MetrologyEquipmentDTO;
  due: MetrologyDueDTO;
  plans: MetrologyPlanVersionDTO[];
  executions: MetrologyExecutionListItemDTO[];
  certificats: MetrologyCertificateDTO[];
  impacts: MetrologyImpactListItemDTO[];
  /** Ce que l'utilisateur courant a le droit de faire : l'UI ne devine rien. */
  capabilities: Record<string, boolean>;
};

/* -------------------------------------------------------------------------- */
/* Exécutions                                                                 */
/* -------------------------------------------------------------------------- */

export type MetrologyExecutionListItemDTO = {
  id: string;
  code: string;
  equipement_id: string;
  operation_type: MetrologyOperationType;
  status: "DRAFT" | "IN_PROGRESS" | "VALIDATED" | "CANCELLED";
  verdict: MetrologyVerdict | null;
  started_at: string;
  ended_at: string | null;
  operator: UserRef | null;
  provider_label: string | null;
  next_due_date: string | null;
  certificate_count: number;
  updated_at: string;
};

export type MetrologyMeasurementDTO = {
  id: string;
  point_key: string;
  sample_no: number;
  label: string | null;
  nominal: number | null;
  tolerance_min: number | null;
  tolerance_max: number | null;
  measured: number | null;
  unite: string | null;
  incertitude: number | null;
  ecart: number | null;
  verdict: "CONFORME" | "NON_CONFORME" | "INCONCLU" | null;
  comment: string | null;
  revision: number;
};

export type MetrologyExecutionDTO = MetrologyExecutionListItemDTO & {
  plan_version_id: string | null;
  plan_version: number | null;
  methode: string | null;
  procedure_ref: string | null;
  etalon_reference: string | null;
  environnement: Record<string, unknown>;
  incertitude: number | null;
  verdict_computed: MetrologyVerdict | null;
  verdict_justification: string | null;
  observations: string | null;
  decision: string | null;
  decision_reason: string | null;
  decided_by: UserRef | null;
  decided_at: string | null;
  restriction: string | null;
  measurements: MetrologyMeasurementDTO[];
  certificats: MetrologyCertificateDTO[];
  created_at: string;
};

/** Aperçu serveur obligatoire avant validation : il porte son empreinte. */
export type MetrologyVerdictPreviewDTO = {
  execution_id: string;
  verdict_computed: MetrologyVerdict;
  explanation: string;
  counts: { total: number; conforme: number; non_conforme: number; inconclu: number };
  points: Array<{
    point_key: string;
    sample_no: number;
    verdict: "CONFORME" | "NON_CONFORME" | "INCONCLU";
    ecart: number | null;
    reason: string | null;
  }>;
  next_due_date: string | null;
  next_due_source: string;
  /** Effets réels annoncés avant confirmation : jamais de surprise après clic. */
  effects: string[];
  preview_hash: string;
};

/* -------------------------------------------------------------------------- */
/* Certificats                                                                */
/* -------------------------------------------------------------------------- */

export type MetrologyCertificateDTO = {
  id: string;
  equipement_id: string;
  execution_id: string | null;
  document_kind: "CERTIFICAT" | "PV_INTERNE" | "RAPPORT" | "AUTRE";
  date_etalonnage: string;
  date_echeance: string | null;
  resultat: "CONFORME" | "NON_CONFORME" | "AJUSTAGE";
  statut: "VALIDE" | "ANNULE" | "REMPLACE";
  emetteur: string | null;
  numero_externe: string | null;
  organisme: string | null;
  commentaire: string | null;
  confidentiality: "INTERNAL" | "RESTRICTED" | "CUSTOMER_VISIBLE";
  cancel_reason: string | null;
  cancelled_at: string | null;
  replaced_by_id: string | null;
  /** Métadonnées non sensibles du fichier. Le chemin réel n'est jamais exposé. */
  file_original_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  has_file: boolean;
  created_at: string;
  created_by: UserRef | null;
};

/* -------------------------------------------------------------------------- */
/* Impact                                                                     */
/* -------------------------------------------------------------------------- */

export type MetrologyImpactListItemDTO = {
  id: string;
  code: string;
  equipement_id: string;
  equipement_code: string | null;
  equipement_designation: string | null;
  trigger_type: "VERDICT_NON_CONFORME" | "CERTIFICAT_INVALIDE" | "MANUEL";
  status: MetrologyImpactStatus;
  priority: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  window_from: string;
  window_to: string;
  volumes: {
    controls: number;
    work_orders: number;
    lots: number;
    deliveries: number;
    truncated: boolean;
  };
  pending_items: number;
  created_at: string;
  updated_at: string;
};

export type MetrologyImpactItemDTO = {
  id: string;
  quality_control_id: string | null;
  control_reference: string | null;
  control_type: string | null;
  control_date: string | null;
  characteristic_key: string | null;
  of_id: number | null;
  lot_id: string | null;
  bon_livraison_id: string | null;
  article_id: string | null;
  affaire_id: number | null;
  decision: MetrologyImpactDecision;
  decision_reason: string | null;
  decided_by: UserRef | null;
  decided_at: string | null;
  non_conformity_id: string | null;
};

export type MetrologyImpactDetailDTO = MetrologyImpactListItemDTO & {
  execution_id: string | null;
  certificat_id: string | null;
  window_source: string;
  method: string;
  scope: Record<string, unknown>;
  exclusions: string | null;
  truncated: boolean;
  owner: UserRef | null;
  conclusion: string | null;
  closed_at: string | null;
  items: Paginated<MetrologyImpactItemDTO>;
  capabilities: Record<string, boolean>;
};

/* -------------------------------------------------------------------------- */
/* Éligibilité et command center                                              */
/* -------------------------------------------------------------------------- */

export type MetrologyEligibilityDTO = {
  instrument_id: string;
  code: string | null;
  designation: string | null;
  eligible: boolean;
  severity: EligibilitySeverity;
  reason_code: MetrologyEligibilityCode;
  message: string;
  reasons: Array<{ code: string; severity: EligibilitySeverity; message: string }>;
  due: MetrologyDueDTO;
};

export type MetrologyEligibilityResultDTO = {
  mode: "single" | "candidates";
  evaluated_at: string;
  policy: { block_on_overdue_critical: boolean };
  results: MetrologyEligibilityDTO[];
};

export type MetrologyCenterDTO = {
  kpis: {
    total: number;
    usable: number;
    due_soon: number;
    overdue: number;
    overdue_critical: number;
    quarantine: number;
    out_of_tolerance: number;
    under_repair: number;
    retired: number;
    open_impacts: number;
  };
  coverage: Array<{
    key: string;
    label: string;
    total: number;
    overdue: number;
    due_soon: number;
  }>;
  upcoming: MetrologyEquipmentListItemDTO[];
  quarantined: MetrologyEquipmentListItemDTO[];
  open_impacts: MetrologyImpactListItemDTO[];
  generated_at: string;
};

export type MetrologyTimelineEntryDTO = {
  id: string;
  entity_type: string | null;
  entity_id: string | null;
  event_type: string;
  reason: string | null;
  rule_code: string | null;
  correlation_id: string | null;
  user: UserRef | null;
  created_at: string;
};

export type MetrologyUsageEntryDTO = {
  quality_control_id: string;
  control_reference: string | null;
  control_type: string | null;
  control_date: string | null;
  characteristic_key: string | null;
  of_id: number | null;
  lot_id: string | null;
  bon_livraison_id: string | null;
  affaire_id: number | null;
  snapshot: MetrologyInstrumentSnapshot | null;
};
