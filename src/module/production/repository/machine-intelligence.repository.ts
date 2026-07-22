import pool from "../../../config/database";
import type {
  MachineCapability,
  MachineDocument,
  MachineInstanceLite,
  MachineIntelligence,
  MachineModelDetail,
  MachineModelListItem,
  MachineModelSummary,
  MachineSpec,
  MachineTooling,
} from "../types/machine-intelligence.types";
import type { ListMachineModelsQueryDTO } from "../validators/machine-intelligence.validators";

function sortDir(dir: "asc" | "desc"): "ASC" | "DESC" {
  return dir === "asc" ? "ASC" : "DESC";
}

function modelSortColumn(sortBy: ListMachineModelsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "updated_at":
      return "m.updated_at";
    case "model":
      return "m.model";
    case "display_name":
      return "m.display_name";
    case "manufacturer":
    default:
      return "m.manufacturer";
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

type ModelRow = {
  id: string;
  model_code: string;
  manufacturer: string;
  model: string;
  display_name: string;
  machine_type: MachineModelListItem["machine_type"];
  axes_count: number | null;
  description: string | null;
  source_summary: string | null;
  is_active: boolean;
  source_confidence: MachineModelListItem["source_confidence"];
  instances_count: number;
  created_at: string;
  updated_at: string;
};

function mapModelListItem(row: ModelRow): MachineModelListItem {
  return {
    id: row.id,
    model_code: row.model_code,
    manufacturer: row.manufacturer,
    model: row.model,
    display_name: row.display_name,
    machine_type: row.machine_type,
    axes_count: row.axes_count,
    is_active: row.is_active,
    source_confidence: row.source_confidence,
    instances_count: Number(row.instances_count ?? 0),
    updated_at: row.updated_at,
  };
}

function mapModelSummary(row: ModelRow): MachineModelSummary {
  return {
    id: row.id,
    model_code: row.model_code,
    manufacturer: row.manufacturer,
    model: row.model,
    display_name: row.display_name,
    machine_type: row.machine_type,
    axes_count: row.axes_count,
    is_active: row.is_active,
    source_confidence: row.source_confidence,
    description: row.description,
    source_summary: row.source_summary,
    updated_at: row.updated_at,
  };
}

export async function repoListMachineModels(filters: ListMachineModelsQueryDTO): Promise<{ items: MachineModelListItem[]; total: number }> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (!filters.include_inactive) where.push("m.is_active IS TRUE");
  if (filters.machine_type) where.push(`m.machine_type = ${push(filters.machine_type)}::machine_type`);
  if (filters.manufacturer) where.push(`m.manufacturer ILIKE ${push(`%${filters.manufacturer}%`)}`);
  if (filters.q) {
    const p = push(`%${filters.q}%`);
    where.push(`(
      m.model_code ILIKE ${p}
      OR m.manufacturer ILIKE ${p}
      OR m.model ILIKE ${p}
      OR m.display_name ILIKE ${p}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const countRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.production_machine_models m ${whereSql}`,
    values
  );

  const orderBy = modelSortColumn(filters.sortBy);
  const orderDir = sortDir(filters.sortDir);

  const dataRes = await pool.query<ModelRow>(
    `
      SELECT
        m.id::text AS id,
        m.model_code,
        m.manufacturer,
        m.model,
        m.display_name,
        m.machine_type::text AS machine_type,
        m.axes_count::int AS axes_count,
        m.description,
        m.source_summary,
        m.is_active,
        s.source_confidence,
        COUNT(inst.id)::int AS instances_count,
        m.created_at::text AS created_at,
        m.updated_at::text AS updated_at
      FROM public.production_machine_models m
      LEFT JOIN public.production_machine_specs s ON s.machine_model_id = m.id
      LEFT JOIN public.machines inst ON inst.machine_model_id = m.id AND inst.archived_at IS NULL
      ${whereSql}
      GROUP BY m.id, s.source_confidence
      ORDER BY ${orderBy} ${orderDir}, m.model ${orderDir}, m.id ${orderDir}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  );

  return {
    items: dataRes.rows.map(mapModelListItem),
    total: countRes.rows[0]?.total ?? 0,
  };
}

async function selectModelSummary(id: string): Promise<MachineModelSummary | null> {
  const res = await pool.query<ModelRow>(
    `
      SELECT
        m.id::text AS id,
        m.model_code,
        m.manufacturer,
        m.model,
        m.display_name,
        m.machine_type::text AS machine_type,
        m.axes_count::int AS axes_count,
        m.description,
        m.source_summary,
        m.is_active,
        s.source_confidence,
        COUNT(inst.id)::int AS instances_count,
        m.created_at::text AS created_at,
        m.updated_at::text AS updated_at
      FROM public.production_machine_models m
      LEFT JOIN public.production_machine_specs s ON s.machine_model_id = m.id
      LEFT JOIN public.machines inst ON inst.machine_model_id = m.id AND inst.archived_at IS NULL
      WHERE m.id = $1::uuid
      GROUP BY m.id, s.source_confidence
      LIMIT 1
    `,
    [id]
  );
  const row = res.rows[0];
  return row ? mapModelSummary(row) : null;
}

async function selectSpecByModelId(modelId: string): Promise<MachineSpec | null> {
  const res = await pool.query<Record<string, unknown>>(
    `
      SELECT
        id::text,
        machine_model_id::text,
        x_travel_mm::float8,
        y_travel_mm::float8,
        z_travel_mm::float8,
        table_length_mm::float8,
        table_width_mm::float8,
        max_table_load_kg::float8,
        max_workpiece_length_mm::float8,
        max_workpiece_width_mm::float8,
        max_workpiece_height_mm::float8,
        machining_envelope_notes,
        rotary_table_info,
        spindle_taper,
        spindle_speed_max_rpm::int,
        spindle_power_kw::float8,
        spindle_torque_nm::float8,
        spindle_motor_specs,
        through_spindle_coolant,
        coolant_pressure_bar::float8,
        tool_magazine_capacity::int,
        max_tool_diameter_mm::float8,
        max_tool_length_mm::float8,
        max_tool_weight_kg::float8,
        tool_change_time_sec::float8,
        compatible_holders,
        rapid_traverse_x_m_min::float8,
        rapid_traverse_y_m_min::float8,
        rapid_traverse_z_m_min::float8,
        cutting_feed_max_m_min::float8,
        acceleration_notes,
        positioning_accuracy_mm::float8,
        repeatability_mm::float8,
        cnc_control,
        control_features,
        communication_interfaces,
        program_format_notes,
        machine_footprint_length_mm::float8,
        machine_footprint_width_mm::float8,
        machine_height_mm::float8,
        machine_weight_kg::float8,
        required_air_pressure_bar::float8,
        power_requirement_kva::float8,
        coolant_tank_capacity_l::float8,
        chip_conveyor_notes,
        operations_notes,
        maintenance_notes,
        source_url,
        source_type,
        source_confidence,
        source_notes,
        updated_at::text
      FROM public.production_machine_specs
      WHERE machine_model_id = $1::uuid
      LIMIT 1
    `,
    [modelId]
  );

  const r = res.rows[0];
  if (!r) return null;

  return {
    id: String(r.id),
    machine_model_id: String(r.machine_model_id),
    x_travel_mm: nullableNumber(r.x_travel_mm),
    y_travel_mm: nullableNumber(r.y_travel_mm),
    z_travel_mm: nullableNumber(r.z_travel_mm),
    table_length_mm: nullableNumber(r.table_length_mm),
    table_width_mm: nullableNumber(r.table_width_mm),
    max_table_load_kg: nullableNumber(r.max_table_load_kg),
    max_workpiece_length_mm: nullableNumber(r.max_workpiece_length_mm),
    max_workpiece_width_mm: nullableNumber(r.max_workpiece_width_mm),
    max_workpiece_height_mm: nullableNumber(r.max_workpiece_height_mm),
    machining_envelope_notes: (r.machining_envelope_notes as string | null) ?? null,
    rotary_table_info: (r.rotary_table_info as string | null) ?? null,
    spindle_taper: (r.spindle_taper as string | null) ?? null,
    spindle_speed_max_rpm: nullableNumber(r.spindle_speed_max_rpm),
    spindle_power_kw: nullableNumber(r.spindle_power_kw),
    spindle_torque_nm: nullableNumber(r.spindle_torque_nm),
    spindle_motor_specs: (r.spindle_motor_specs as string | null) ?? null,
    through_spindle_coolant: (r.through_spindle_coolant as boolean | null) ?? null,
    coolant_pressure_bar: nullableNumber(r.coolant_pressure_bar),
    tool_magazine_capacity: nullableNumber(r.tool_magazine_capacity),
    max_tool_diameter_mm: nullableNumber(r.max_tool_diameter_mm),
    max_tool_length_mm: nullableNumber(r.max_tool_length_mm),
    max_tool_weight_kg: nullableNumber(r.max_tool_weight_kg),
    tool_change_time_sec: nullableNumber(r.tool_change_time_sec),
    compatible_holders: stringArray(r.compatible_holders),
    rapid_traverse_x_m_min: nullableNumber(r.rapid_traverse_x_m_min),
    rapid_traverse_y_m_min: nullableNumber(r.rapid_traverse_y_m_min),
    rapid_traverse_z_m_min: nullableNumber(r.rapid_traverse_z_m_min),
    cutting_feed_max_m_min: nullableNumber(r.cutting_feed_max_m_min),
    acceleration_notes: (r.acceleration_notes as string | null) ?? null,
    positioning_accuracy_mm: nullableNumber(r.positioning_accuracy_mm),
    repeatability_mm: nullableNumber(r.repeatability_mm),
    cnc_control: (r.cnc_control as string | null) ?? null,
    control_features: stringArray(r.control_features),
    communication_interfaces: stringArray(r.communication_interfaces),
    program_format_notes: (r.program_format_notes as string | null) ?? null,
    machine_footprint_length_mm: nullableNumber(r.machine_footprint_length_mm),
    machine_footprint_width_mm: nullableNumber(r.machine_footprint_width_mm),
    machine_height_mm: nullableNumber(r.machine_height_mm),
    machine_weight_kg: nullableNumber(r.machine_weight_kg),
    required_air_pressure_bar: nullableNumber(r.required_air_pressure_bar),
    power_requirement_kva: nullableNumber(r.power_requirement_kva),
    coolant_tank_capacity_l: nullableNumber(r.coolant_tank_capacity_l),
    chip_conveyor_notes: (r.chip_conveyor_notes as string | null) ?? null,
    operations_notes: (r.operations_notes as string | null) ?? null,
    maintenance_notes: (r.maintenance_notes as string | null) ?? null,
    source_url: (r.source_url as string | null) ?? null,
    source_type: r.source_type as MachineSpec["source_type"],
    source_confidence: r.source_confidence as MachineSpec["source_confidence"],
    source_notes: (r.source_notes as string | null) ?? null,
    updated_at: String(r.updated_at),
  };
}

async function selectCapabilitiesByModelId(modelId: string): Promise<MachineCapability[]> {
  const res = await pool.query<MachineCapability>(
    `
      SELECT
        id::text AS id,
        machine_model_id::text AS machine_model_id,
        process_type,
        material_family,
        capability_level,
        notes,
        source_url,
        source_confidence
      FROM public.production_machine_capabilities
      WHERE machine_model_id = $1::uuid
      ORDER BY capability_level ASC, process_type ASC, material_family ASC NULLS LAST
    `,
    [modelId]
  );
  return res.rows;
}

async function selectToolingByModelId(modelId: string): Promise<MachineTooling[]> {
  const res = await pool.query<MachineTooling>(
    `
      SELECT
        id::text AS id,
        machine_model_id::text AS machine_model_id,
        holder_type,
        spindle_taper,
        tool_family,
        outillage_family_id,
        compatible,
        notes,
        source_url,
        source_confidence
      FROM public.production_machine_tooling
      WHERE machine_model_id = $1::uuid
      ORDER BY compatible DESC, holder_type ASC, tool_family ASC NULLS LAST
    `,
    [modelId]
  );
  return res.rows;
}

async function selectDocuments(params: { model_id?: string | null; machine_id?: string | null }): Promise<MachineDocument[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (params.model_id) where.push(`machine_model_id = ${push(params.model_id)}::uuid`);
  if (params.machine_id) where.push(`machine_id = ${push(params.machine_id)}::uuid`);
  if (!where.length) return [];

  const res = await pool.query<MachineDocument>(
    `
      SELECT
        id::text AS id,
        machine_model_id::text AS machine_model_id,
        machine_id::text AS machine_id,
        title,
        document_type,
        url,
        revision,
        sha256,
        mime_type,
        size_bytes::float8 AS size_bytes,
        authored_at::text AS authored_at,
        source_type,
        source_confidence,
        source_notes,
        retrieved_at::text AS retrieved_at,
        removed_at::text AS removed_at
      FROM public.production_machine_documents
      WHERE (${where.join(" OR ")}) AND removed_at IS NULL
      ORDER BY
        CASE document_type
          WHEN 'MANUAL' THEN 1
          WHEN 'BROCHURE_PDF' THEN 2
          WHEN 'OFFICIAL_PAGE' THEN 3
          WHEN 'RESALE_LISTING' THEN 4
          ELSE 5
        END,
        title ASC
    `,
    values
  );
  return res.rows;
}

async function selectInstancesByModelId(modelId: string): Promise<MachineInstanceLite[]> {
  const res = await pool.query<MachineInstanceLite>(
    `
      SELECT
        id::text AS id,
        code,
        name,
        display_name,
        status::text AS status,
        is_available,
        dashboard_color,
        model_3d_path,
        workshop_zone,
        location,
        archived_at::text AS archived_at
      FROM public.machines
      WHERE machine_model_id = $1::uuid
      ORDER BY code ASC, id ASC
    `,
    [modelId]
  );
  return res.rows;
}

export async function repoGetMachineModel(id: string): Promise<MachineModelDetail | null> {
  const model = await selectModelSummary(id);
  if (!model) return null;

  const [specs, capabilities, tooling, documents, instances] = await Promise.all([
    selectSpecByModelId(id),
    selectCapabilitiesByModelId(id),
    selectToolingByModelId(id),
    selectDocuments({ model_id: id }),
    selectInstancesByModelId(id),
  ]);

  return {
    ...model,
    specs,
    capabilities,
    tooling,
    documents,
    instances,
  };
}

async function selectMachineModelId(machineId: string): Promise<string | null | undefined> {
  const res = await pool.query<{ machine_model_id: string | null }>(
    `SELECT machine_model_id::text AS machine_model_id FROM public.machines WHERE id = $1::uuid LIMIT 1`,
    [machineId]
  );
  if (!res.rows.length) return undefined;
  return res.rows[0]?.machine_model_id ?? null;
}

export async function repoGetMachineIntelligence(machineId: string): Promise<MachineIntelligence | null> {
  const modelId = await selectMachineModelId(machineId);
  if (modelId === undefined) return null;

  if (!modelId) {
    return {
      machine_model: null,
      specs: null,
      capabilities: [],
      tooling: [],
      documents: await selectDocuments({ machine_id: machineId }),
    };
  }

  const [machine_model, specs, capabilities, tooling, documents] = await Promise.all([
    selectModelSummary(modelId),
    selectSpecByModelId(modelId),
    selectCapabilitiesByModelId(modelId),
    selectToolingByModelId(modelId),
    selectDocuments({ model_id: modelId, machine_id: machineId }),
  ]);

  return {
    machine_model,
    specs,
    capabilities,
    tooling,
    documents,
  };
}

export async function repoListMachineCapabilities(machineId: string): Promise<MachineCapability[] | null> {
  const intelligence = await repoGetMachineIntelligence(machineId);
  if (!intelligence) return null;
  return intelligence.capabilities;
}

export async function repoListMachineDocuments(machineId: string): Promise<MachineDocument[] | null> {
  const intelligence = await repoGetMachineIntelligence(machineId);
  if (!intelligence) return null;
  return intelligence.documents;
}

export async function repoListMachineModelCapabilities(modelId: string): Promise<MachineCapability[] | null> {
  const model = await selectModelSummary(modelId);
  if (!model) return null;
  return selectCapabilitiesByModelId(modelId);
}

export async function repoListMachineModelDocuments(modelId: string): Promise<MachineDocument[] | null> {
  const model = await selectModelSummary(modelId);
  if (!model) return null;
  return selectDocuments({ model_id: modelId });
}
