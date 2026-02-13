export type Paginated<T> = {
  items: T[];
  total: number;
};

export type QualityControlType = "IN_PROCESS" | "FINAL" | "RECEPTION" | "PERIODIC";
export type QualityControlStatus = "PLANNED" | "IN_PROGRESS" | "VALIDATED" | "REJECTED";
export type QualityControlResult = "OK" | "NOK" | "PARTIAL";

export type QualityPointResult = "OK" | "NOK";

export type NonConformitySeverity = "MINOR" | "MAJOR" | "CRITICAL";
export type NonConformityStatus = "OPEN" | "ANALYSIS" | "ACTION_PLAN" | "CLOSED";

export type QualityActionType = "CORRECTIVE" | "PREVENTIVE";
export type QualityActionStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "VERIFIED";

export type QualityEntityType = "CONTROL" | "NON_CONFORMITY" | "ACTION";
export type QualityDocumentType = "PV" | "PHOTO" | "CERTIFICATE" | "REPORT" | "OTHER";

export type QualityUserLite = {
  id: number;
  username: string;
  name: string | null;
  surname: string | null;
  label: string;
};

export type QualityMachineLite = {
  id: string;
  code: string;
  name: string;
};

export type QualityPosteLite = {
  id: string;
  code: string;
  label: string;
};

export type QualityOfLite = {
  id: number;
  numero: string;
  client_id: string | null;
  client_company_name: string | null;
  affaire_id: number | null;
};

export type QualityAffaireLite = {
  id: number;
  reference: string;
  client_id: string | null;
  client_company_name: string | null;
};

export type QualityPieceTechniqueLite = {
  id: string;
  code_piece: string;
  designation: string;
};

export type QualityOperationLite = {
  id: string;
  phase: number;
  designation: string;
};

export type QualityControlPoint = {
  id: string;
  quality_control_id: string;
  characteristic: string;
  nominal_value: number | null;
  tolerance_min: number | null;
  tolerance_max: number | null;
  measured_value: number | null;
  unit: string | null;
  result: QualityPointResult | null;
  comment: string | null;
  created_at: string;
  updated_at: string;
};

export type QualityDocument = {
  id: string;
  entity_type: QualityEntityType;
  entity_id: string;
  document_type: QualityDocumentType;
  version: number;
  original_name: string;
  stored_name: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string | null;
  label: string | null;
  created_at: string;
  updated_at: string;
  uploaded_by: number | null;
  removed_at: string | null;
  removed_by: number | null;
};

export type QualityEventLog = {
  id: number;
  entity_type: QualityEntityType;
  entity_id: string;
  event_type: string;
  old_values: unknown | null;
  new_values: unknown | null;
  user: QualityUserLite;
  created_at: string;
};

export type QualityControlListItem = {
  id: string;
  control_type: QualityControlType;
  status: QualityControlStatus;
  result: QualityControlResult | null;
  control_date: string;
  comments: string | null;

  affaire: QualityAffaireLite | null;
  of: QualityOfLite | null;
  piece_technique: QualityPieceTechniqueLite | null;
  operation: QualityOperationLite | null;
  machine: QualityMachineLite | null;
  poste: QualityPosteLite | null;

  controlled_by: QualityUserLite;
};

export type QualityControlDetail = QualityControlListItem & {
  validated_by: QualityUserLite | null;
  validation_date: string | null;
  created_at: string;
  updated_at: string;
  created_by: QualityUserLite;
  updated_by: QualityUserLite;
  points: QualityControlPoint[];
  documents: QualityDocument[];
  events: QualityEventLog[];
};

export type NonConformityListItem = {
  id: string;
  reference: string;
  description: string;
  severity: NonConformitySeverity;
  status: NonConformityStatus;
  detection_date: string;

  affaire: QualityAffaireLite | null;
  of: QualityOfLite | null;
  piece_technique: QualityPieceTechniqueLite | null;
  control_id: string | null;
  client_id: string | null;
  client_company_name: string | null;

  detected_by: QualityUserLite;
};

export type NonConformityDetail = NonConformityListItem & {
  root_cause: string | null;
  impact: string | null;
  created_at: string;
  updated_at: string;
  created_by: QualityUserLite;
  updated_by: QualityUserLite;
  actions: QualityActionListItem[];
  documents: QualityDocument[];
  events: QualityEventLog[];
};

export type QualityActionListItem = {
  id: string;
  non_conformity_id: string;
  non_conformity_reference: string;
  action_type: QualityActionType;
  description: string;
  responsible: QualityUserLite;
  due_date: string | null;
  status: QualityActionStatus;
  verification_user: QualityUserLite | null;
  verification_date: string | null;
};

export type QualityActionDetail = QualityActionListItem & {
  effectiveness_comment: string | null;
  created_at: string;
  updated_at: string;
  created_by: QualityUserLite;
  updated_by: QualityUserLite;
  documents: QualityDocument[];
  events: QualityEventLog[];
};

export type QualityKpis = {
  kpis: {
    open_controls: number;
    rejected_controls: number;
    open_non_conformities: number;
    actions_overdue: number;
  };
};
