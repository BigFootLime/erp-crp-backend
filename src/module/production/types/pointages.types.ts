export type PointageTimeType = "OPERATEUR" | "MACHINE" | "PROGRAMMATION";

export type PointageStatus = "RUNNING" | "DONE" | "CANCELLED" | "CORRECTED";

export type PointageUserLite = {
  id: number;
  username: string;
  name: string | null;
  surname: string | null;
  label: string;
};

export type PointageMachineLite = {
  id: string;
  code: string;
  name: string;
  image_url: string | null;
};

export type PointagePosteLite = {
  id: string;
  code: string;
  label: string;
};

export type PointageOfLite = {
  id: number;
  numero: string;
  client_id: string | null;
  client_company_name: string | null;
  affaire_id: number | null;
};

export type PointageAffaireLite = {
  id: number;
  reference: string;
};

export type PointagePieceTechniqueLite = {
  id: string;
  code_piece: string;
  designation: string;
};

export type PointageOperationLite = {
  id: string;
  phase: number;
  designation: string;
};

export type ProductionPointageListItem = {
  id: string;
  status: PointageStatus;
  time_type: PointageTimeType;
  start_ts: string;
  end_ts: string | null;
  duration_minutes: number | null;
  comment: string | null;

  of: PointageOfLite;
  affaire: PointageAffaireLite | null;
  piece_technique: PointagePieceTechniqueLite | null;
  operation: PointageOperationLite | null;
  machine: PointageMachineLite | null;
  poste: PointagePosteLite | null;
  operator: PointageUserLite;
};

export type ProductionPointageEvent = {
  id: number;
  pointage_id: string;
  event_type: string;
  old_values: unknown | null;
  new_values: unknown | null;
  user: PointageUserLite;
  created_at: string;
  note: string | null;
};

export type ProductionPointageDetail = ProductionPointageListItem & {
  correction_reason: string | null;
  validated_at: string | null;
  validated_by: PointageUserLite | null;
  created_at: string;
  updated_at: string;
  created_by: PointageUserLite;
  updated_by: PointageUserLite;
  events: ProductionPointageEvent[];
};

export type ProductionPointagesKpis = {
  range: { from: string; to: string };
  kpis: {
    total_minutes: number;
    running_count: number;
    by_type_minutes: Record<PointageTimeType, number>;
  };
};
