import type { MachineTypeDTO } from "../validators/production.validators";

export type SourceConfidence = "official" | "resale_listing" | "estimated" | "internal" | "unknown";
export type SourceType = "manufacturer_page" | "manufacturer_pdf" | "resale_listing" | "internal_note" | "mixed" | "unknown";

export type MachineModelListItem = {
  id: string;
  model_code: string;
  manufacturer: string;
  model: string;
  display_name: string;
  machine_type: MachineTypeDTO;
  axes_count: number | null;
  is_active: boolean;
  source_confidence: SourceConfidence | null;
  instances_count: number;
  updated_at: string;
};

export type MachineModelSummary = Omit<MachineModelListItem, "instances_count"> & {
  description: string | null;
  source_summary: string | null;
};

export type MachineSpec = {
  id: string;
  machine_model_id: string;
  x_travel_mm: number | null;
  y_travel_mm: number | null;
  z_travel_mm: number | null;
  table_length_mm: number | null;
  table_width_mm: number | null;
  max_table_load_kg: number | null;
  max_workpiece_length_mm: number | null;
  max_workpiece_width_mm: number | null;
  max_workpiece_height_mm: number | null;
  machining_envelope_notes: string | null;
  rotary_table_info: string | null;
  spindle_taper: string | null;
  spindle_speed_max_rpm: number | null;
  spindle_power_kw: number | null;
  spindle_torque_nm: number | null;
  spindle_motor_specs: string | null;
  through_spindle_coolant: boolean | null;
  coolant_pressure_bar: number | null;
  tool_magazine_capacity: number | null;
  max_tool_diameter_mm: number | null;
  max_tool_length_mm: number | null;
  max_tool_weight_kg: number | null;
  tool_change_time_sec: number | null;
  compatible_holders: string[];
  rapid_traverse_x_m_min: number | null;
  rapid_traverse_y_m_min: number | null;
  rapid_traverse_z_m_min: number | null;
  cutting_feed_max_m_min: number | null;
  acceleration_notes: string | null;
  positioning_accuracy_mm: number | null;
  repeatability_mm: number | null;
  cnc_control: string | null;
  control_features: string[];
  communication_interfaces: string[];
  program_format_notes: string | null;
  machine_footprint_length_mm: number | null;
  machine_footprint_width_mm: number | null;
  machine_height_mm: number | null;
  machine_weight_kg: number | null;
  required_air_pressure_bar: number | null;
  power_requirement_kva: number | null;
  coolant_tank_capacity_l: number | null;
  chip_conveyor_notes: string | null;
  operations_notes: string | null;
  maintenance_notes: string | null;
  source_url: string | null;
  source_type: SourceType;
  source_confidence: SourceConfidence;
  source_notes: string | null;
  updated_at: string;
};

export type MachineCapability = {
  id: string;
  machine_model_id: string;
  process_type: string;
  material_family: string | null;
  capability_level: "preferred" | "primary" | "supported" | "limited" | "unknown";
  notes: string | null;
  source_url: string | null;
  source_confidence: SourceConfidence;
};

export type MachineTooling = {
  id: string;
  machine_model_id: string;
  holder_type: string;
  spindle_taper: string | null;
  tool_family: string | null;
  outillage_family_id: number | null;
  compatible: boolean;
  notes: string | null;
  source_url: string | null;
  source_confidence: SourceConfidence;
};

export type MachineDocument = {
  id: string;
  machine_model_id: string | null;
  machine_id: string | null;
  title: string;
  document_type: "OFFICIAL_PAGE" | "BROCHURE_PDF" | "MANUAL" | "IMAGE" | "RESALE_LISTING" | "INTERNAL_NOTE" | "CERTIFICATE" | "MAINTENANCE" | "PHOTO" | "MODEL_3D";
  url: string | null;
  revision: string | null;
  sha256: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  authored_at: string | null;
  source_type: SourceType;
  source_confidence: SourceConfidence;
  source_notes: string | null;
  retrieved_at: string;
  removed_at: string | null;
};

export type MachineInstanceLite = {
  id: string;
  code: string;
  name: string;
  display_name: string | null;
  status: string;
  is_available: boolean;
  dashboard_color: string | null;
  model_3d_path: string | null;
  workshop_zone: string | null;
  location: string | null;
  archived_at: string | null;
};

export type MachineModelDetail = MachineModelSummary & {
  specs: MachineSpec | null;
  capabilities: MachineCapability[];
  tooling: MachineTooling[];
  documents: MachineDocument[];
  instances: MachineInstanceLite[];
};

export type MachineIntelligence = {
  machine_model: MachineModelSummary | null;
  specs: MachineSpec | null;
  capabilities: MachineCapability[];
  tooling: MachineTooling[];
  documents: MachineDocument[];
};
