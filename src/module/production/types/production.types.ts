import type {
  MachineStatusDTO,
  MachineTypeDTO,
  OfOperationStatusDTO,
  OfPriorityDTO,
  OfStatusDTO,
  OfTimeLogTypeDTO,
} from "../validators/production.validators";
import type {
  MachineCapability,
  MachineDocument,
  MachineModelSummary,
  MachineSpec,
  MachineTooling,
} from "./machine-intelligence.types";

export type Paginated<T> = { items: T[]; total: number };

export type MachineListItem = {
  id: string;
  code: string;
  name: string;
  type: MachineTypeDTO;
  machine_model_id: string | null;
  model_display_name: string | null;
  manufacturer: string | null;
  model_name: string | null;
  display_name: string | null;
  status: MachineStatusDTO;
  hourly_rate: number | null;
  hourly_rate_source: "INTERNAL_COST" | "POSTE_INHERITED" | "IMPORTED" | "MANUAL_OVERRIDE" | "UNKNOWN" | null;
  hourly_rate_effective_at: string | null;
  hourly_rate_is_override: boolean;
  currency: string;
  is_available: boolean;
  image_url: string | null;
  dashboard_color: string | null;
  model_3d_path: string | null;
  documentation_url: string | null;
  documentation_source: string | null;
  scheduling_enabled: boolean;
  outillage_enabled: boolean;
  archived_at: string | null;
  updated_at: string;
};

export type MachineDetail = MachineListItem & {
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  commissioned_year: number | null;
  location: string | null;
  workshop_zone: string | null;
  notes: string | null;
  created_at: string;
  created_by: number | null;
  updated_by: number | null;
  archived_by: number | null;
  image_path: string | null;
  machine_model?: MachineModelSummary | null;
  specs?: MachineSpec | null;
  capabilities?: MachineCapability[];
  tooling?: MachineTooling[];
  documents?: MachineDocument[];
};

export type PosteListItem = {
  id: string;
  code: string;
  label: string;
  machine_id: string | null;
  hourly_rate_override: number | null;
  currency: string;
  is_active: boolean;
  archived_at: string | null;
  updated_at: string;
};

export type PosteDetail = PosteListItem & {
  notes: string | null;
  created_at: string;
  created_by: number | null;
  updated_by: number | null;
  archived_by: number | null;
};

export type OrdreFabricationListItem = {
  id: number;
  numero: string;
  affaire_id: number | null;
  commande_id: number | null;
  parent_of_id: number | null;
  root_of_id: number | null;
  generation_batch_id: string | null;
  generation_level: number;
  source_bom_line_id: string | null;
  structure_path: string | null;
  quantity_per_parent: number;
  quantity_cumulative: number;
  client_id: string | null;
  client_company_name: string | null;
  production_group_id: string | null;
  production_group_code: string | null;
  piece_technique_id: string;
  piece_code: string;
  piece_designation: string;
  quantite_lancee: number;
  quantite_bonne: number;
  quantite_rebut: number;
  statut: OfStatusDTO;
  priority: OfPriorityDTO;
  date_lancement_prevue: string | null;
  date_fin_prevue: string | null;
  updated_at: string;
  total_ops: number;
  done_ops: number;
};

export type OfTimeLog = {
  id: string;
  of_operation_id: string;
  user_id: number;
  machine_id: string | null;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  type: OfTimeLogTypeDTO;
  comment: string | null;
  created_at: string;
};

export type OfOperation = {
  id: string;
  of_id: number;
  phase: number;
  designation: string;
  cf_id: string | null;
  poste_id: string | null;
  poste_code: string | null;
  poste_label: string | null;
  machine_id: string | null;
  machine_code: string | null;
  machine_name: string | null;
  hourly_rate_applied: number;
  tp: number;
  tf_unit: number;
  qte: number;
  coef: number;
  temps_total_planned: number;
  temps_total_real: number;
  status: OfOperationStatusDTO;
  started_at: string | null;
  ended_at: string | null;
  notes: string | null;
  updated_at: string;
  open_time_log: OfTimeLog | null;
};

export type OrdreFabricationDetail = {
  id: number;
  numero: string;
  affaire_id: number | null;
  commande_id: number | null;
  parent_of_id: number | null;
  root_of_id: number | null;
  generation_batch_id: string | null;
  generation_level: number;
  source_bom_line_id: string | null;
  structure_path: string | null;
  quantity_per_parent: number;
  quantity_cumulative: number;
  client_id: string | null;
  client_company_name: string | null;
  production_group_id: string | null;
  production_group_code: string | null;
  piece_technique_id: string;
  piece_technique_version_id: string | null;
  technical_snapshot_sha256: string | null;
  technical_snapshot_at: string | null;
  piece_code: string;
  piece_designation: string;
  quantite_lancee: number;
  quantite_bonne: number;
  quantite_rebut: number;
  statut: OfStatusDTO;
  priority: OfPriorityDTO;
  date_lancement_prevue: string | null;
  date_fin_prevue: string | null;
  date_lancement_reelle: string | null;
  date_fin_reelle: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  updated_by: number | null;
  operations: OfOperation[];
  // #170 : transitions licites depuis le statut courant (automate serveur).
  allowed_statut_transitions: OfStatusDTO[];
};

export type OrdreFabricationTreeNode = Omit<OrdreFabricationListItem, "updated_at" | "total_ops" | "done_ops"> & {
  updated_at: string;
  total_ops: number;
  done_ops: number;
  children: OrdreFabricationTreeNode[];
};

export type OrdreFabricationTree = {
  root: OrdreFabricationTreeNode;
  nodes: OrdreFabricationTreeNode[];
  total_nodes: number;
  max_depth: number;
};
