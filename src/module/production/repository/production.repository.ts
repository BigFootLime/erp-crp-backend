import type { PoolClient } from "pg";
import crypto from "node:crypto";
import path from "node:path";

import pool from "../../../config/database";
import { generateMachineCode, generateTransactionalBusinessCode } from "../../../shared/codes/code-generator.service";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type {
  MachineDetail,
  MachineListItem,
  OfOperation,
  OfTimeLog,
  OrdreFabricationDetail,
  OrdreFabricationListItem,
  OrdreFabricationTree,
  OrdreFabricationTreeNode,
  Paginated,
  PosteDetail,
  PosteListItem,
} from "../types/production.types";
import type {
  CreateMachineBodyDTO,
  CreateMachineOnboardingBodyDTO,
  CreateOfBodyDTO,
  CreatePosteBodyDTO,
  ListMachinesQueryDTO,
  ListOfQueryDTO,
  ListPostesQueryDTO,
  StartOfTimeLogBodyDTO,
  StopOfTimeLogBodyDTO,
  UpdateMachineBodyDTO,
  UpdateMachineOnboardingBodyDTO,
  UpdateOfBodyDTO,
  UpdateOfOperationBodyDTO,
  UpdatePosteBodyDTO,
  ReorderOfOperationsBodyDTO,
} from "../validators/production.validators";
import {
  OF_STATUT_TRANSITIONS,
  canTransitionOfStatut,
  canTransitionOfOperationStatus,
  isOfPrelaunch,
  ofOperationsAllowReorder,
  ofStatutAllowsExecution,
  type OfOperationStatus,
  type OfStatut,
} from "../domain/of-status";
import { capabilityForOfTransition, roleHasOfCapability } from "../domain/of-rbac";
import { copyPieceOperationsToOf, loadApplicableTechnicalSnapshot } from "../domain/of-generation";

export type AuditContext = {
  user_id: number;
  // #170 : rôle porté jusqu'au repository pour les capacités fines OF
  // (transition, édition pré-lancement). Optionnel pour compatibilité.
  user_role?: string | null;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

type DbQueryer = Pick<PoolClient, "query">;

const BASE_IMAGE_URL = process.env.BACKEND_URL || "http://erp-backend.croix-rousse-precision.fr:8080";

function imageUrl(imagePath: string | null): string | null {
  if (!imagePath) return null;
  return `${BASE_IMAGE_URL}/images/${path.basename(imagePath)}`;
}

async function insertAuditLog(tx: DbQueryer, audit: AuditContext, entry: {
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details?: Record<string, unknown> | null;
}) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };

  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

function pgConstraint(err: unknown): string | null {
  const value = (err as { constraint?: unknown } | null)?.constraint;
  return typeof value === "string" ? value : null;
}

function isPgForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23503";
}

function textOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function makeMachineModelCode(manufacturer: string, model: string): string {
  const raw = `${manufacturer}-${model}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return raw.slice(0, 120) || `MACHINE-MODEL-${Date.now()}`;
}

function hasModelDraft(input: CreateMachineOnboardingBodyDTO["machine_model"]): input is NonNullable<CreateMachineOnboardingBodyDTO["machine_model"]> {
  if (!input) return false;
  return Boolean(
    input.id ||
      textOrNull(input.manufacturer) ||
      textOrNull(input.model) ||
      textOrNull(input.display_name) ||
      textOrNull(input.model_code) ||
      input.axes_count
  );
}

function hasSpecDraft(input: CreateMachineOnboardingBodyDTO["specs"]): input is NonNullable<CreateMachineOnboardingBodyDTO["specs"]> {
  if (!input) return false;
  return Object.entries(input).some(([key, value]) => {
    if (key === "source_type" || key === "source_confidence") return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value.trim().length > 0;
    return value !== null && value !== undefined;
  });
}

type MachineModelMini = {
  id: string;
  model_code: string;
  manufacturer: string;
  model: string;
  display_name: string;
  updated_at?: string;
};

type MachineOnboardingSpecInput = NonNullable<CreateMachineOnboardingBodyDTO["specs"]>;
type MachineOnboardingCapabilityInput = NonNullable<CreateMachineOnboardingBodyDTO["capabilities"]>[number];
type MachineOnboardingToolingInput = NonNullable<CreateMachineOnboardingBodyDTO["tooling"]>[number];

async function selectMachineModelMini(tx: DbQueryer, id: string): Promise<MachineModelMini | null> {
  const existing = await tx.query<MachineModelMini>(
    `
      SELECT
        id::text AS id,
        model_code,
        manufacturer,
        model,
        display_name,
        updated_at::text AS updated_at
      FROM public.production_machine_models
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [id]
  );
  return existing.rows[0] ?? null;
}

async function upsertMachineSpecs(
  tx: DbQueryer,
  modelId: string,
  specs: MachineOnboardingSpecInput,
  mode: "merge" | "replace"
): Promise<void> {
  const replaceExisting = mode === "replace";
  await tx.query(
    `
      INSERT INTO public.production_machine_specs (
        machine_model_id,
        x_travel_mm,
        y_travel_mm,
        z_travel_mm,
        table_length_mm,
        table_width_mm,
        max_table_load_kg,
        spindle_taper,
        spindle_speed_max_rpm,
        spindle_power_kw,
        spindle_torque_nm,
        tool_magazine_capacity,
        max_tool_diameter_mm,
        max_tool_length_mm,
        max_tool_weight_kg,
        tool_change_time_sec,
        compatible_holders,
        operations_notes,
        maintenance_notes,
        source_url,
        source_type,
        source_confidence,
        source_notes
      )
      VALUES (
        $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::text[],$18,$19,$20,$21,$22,$23
      )
      ON CONFLICT (machine_model_id) DO UPDATE
      SET
        x_travel_mm = CASE WHEN $24::boolean THEN EXCLUDED.x_travel_mm ELSE COALESCE(EXCLUDED.x_travel_mm, public.production_machine_specs.x_travel_mm) END,
        y_travel_mm = CASE WHEN $24::boolean THEN EXCLUDED.y_travel_mm ELSE COALESCE(EXCLUDED.y_travel_mm, public.production_machine_specs.y_travel_mm) END,
        z_travel_mm = CASE WHEN $24::boolean THEN EXCLUDED.z_travel_mm ELSE COALESCE(EXCLUDED.z_travel_mm, public.production_machine_specs.z_travel_mm) END,
        table_length_mm = CASE WHEN $24::boolean THEN EXCLUDED.table_length_mm ELSE COALESCE(EXCLUDED.table_length_mm, public.production_machine_specs.table_length_mm) END,
        table_width_mm = CASE WHEN $24::boolean THEN EXCLUDED.table_width_mm ELSE COALESCE(EXCLUDED.table_width_mm, public.production_machine_specs.table_width_mm) END,
        max_table_load_kg = CASE WHEN $24::boolean THEN EXCLUDED.max_table_load_kg ELSE COALESCE(EXCLUDED.max_table_load_kg, public.production_machine_specs.max_table_load_kg) END,
        spindle_taper = CASE WHEN $24::boolean THEN EXCLUDED.spindle_taper ELSE COALESCE(EXCLUDED.spindle_taper, public.production_machine_specs.spindle_taper) END,
        spindle_speed_max_rpm = CASE WHEN $24::boolean THEN EXCLUDED.spindle_speed_max_rpm ELSE COALESCE(EXCLUDED.spindle_speed_max_rpm, public.production_machine_specs.spindle_speed_max_rpm) END,
        spindle_power_kw = CASE WHEN $24::boolean THEN EXCLUDED.spindle_power_kw ELSE COALESCE(EXCLUDED.spindle_power_kw, public.production_machine_specs.spindle_power_kw) END,
        spindle_torque_nm = CASE WHEN $24::boolean THEN EXCLUDED.spindle_torque_nm ELSE COALESCE(EXCLUDED.spindle_torque_nm, public.production_machine_specs.spindle_torque_nm) END,
        tool_magazine_capacity = CASE WHEN $24::boolean THEN EXCLUDED.tool_magazine_capacity ELSE COALESCE(EXCLUDED.tool_magazine_capacity, public.production_machine_specs.tool_magazine_capacity) END,
        max_tool_diameter_mm = CASE WHEN $24::boolean THEN EXCLUDED.max_tool_diameter_mm ELSE COALESCE(EXCLUDED.max_tool_diameter_mm, public.production_machine_specs.max_tool_diameter_mm) END,
        max_tool_length_mm = CASE WHEN $24::boolean THEN EXCLUDED.max_tool_length_mm ELSE COALESCE(EXCLUDED.max_tool_length_mm, public.production_machine_specs.max_tool_length_mm) END,
        max_tool_weight_kg = CASE WHEN $24::boolean THEN EXCLUDED.max_tool_weight_kg ELSE COALESCE(EXCLUDED.max_tool_weight_kg, public.production_machine_specs.max_tool_weight_kg) END,
        tool_change_time_sec = CASE WHEN $24::boolean THEN EXCLUDED.tool_change_time_sec ELSE COALESCE(EXCLUDED.tool_change_time_sec, public.production_machine_specs.tool_change_time_sec) END,
        compatible_holders = CASE
          WHEN $24::boolean THEN EXCLUDED.compatible_holders
          WHEN array_length(EXCLUDED.compatible_holders, 1) IS NULL THEN public.production_machine_specs.compatible_holders
          ELSE EXCLUDED.compatible_holders
        END,
        operations_notes = CASE WHEN $24::boolean THEN EXCLUDED.operations_notes ELSE COALESCE(EXCLUDED.operations_notes, public.production_machine_specs.operations_notes) END,
        maintenance_notes = CASE WHEN $24::boolean THEN EXCLUDED.maintenance_notes ELSE COALESCE(EXCLUDED.maintenance_notes, public.production_machine_specs.maintenance_notes) END,
        source_url = CASE WHEN $24::boolean THEN EXCLUDED.source_url ELSE COALESCE(EXCLUDED.source_url, public.production_machine_specs.source_url) END,
        source_type = EXCLUDED.source_type,
        source_confidence = EXCLUDED.source_confidence,
        source_notes = CASE WHEN $24::boolean THEN EXCLUDED.source_notes ELSE COALESCE(EXCLUDED.source_notes, public.production_machine_specs.source_notes) END,
        updated_at = now()
    `,
    [
      modelId,
      specs.x_travel_mm ?? null,
      specs.y_travel_mm ?? null,
      specs.z_travel_mm ?? null,
      specs.table_length_mm ?? null,
      specs.table_width_mm ?? null,
      specs.max_table_load_kg ?? null,
      textOrNull(specs.spindle_taper),
      specs.spindle_speed_max_rpm ?? null,
      specs.spindle_power_kw ?? null,
      specs.spindle_torque_nm ?? null,
      specs.tool_magazine_capacity ?? null,
      specs.max_tool_diameter_mm ?? null,
      specs.max_tool_length_mm ?? null,
      specs.max_tool_weight_kg ?? null,
      specs.tool_change_time_sec ?? null,
      specs.compatible_holders ?? [],
      textOrNull(specs.operations_notes),
      textOrNull(specs.maintenance_notes),
      textOrNull(specs.source_url),
      specs.source_type ?? "internal_note",
      specs.source_confidence ?? "internal",
      textOrNull(specs.source_notes),
      replaceExisting,
    ]
  );
}

async function upsertMachineCapabilities(
  tx: DbQueryer,
  modelId: string,
  capabilities: MachineOnboardingCapabilityInput[]
): Promise<void> {
  for (const capability of capabilities) {
    await tx.query(
      `
        INSERT INTO public.production_machine_capabilities (
          machine_model_id,
          process_type,
          material_family,
          capability_level,
          notes,
          source_confidence
        )
        VALUES ($1::uuid,$2,$3,$4,$5,$6)
        ON CONFLICT (machine_model_id, process_type, (COALESCE(material_family, ''))) DO UPDATE
        SET
          capability_level = EXCLUDED.capability_level,
          notes = COALESCE(EXCLUDED.notes, public.production_machine_capabilities.notes),
          source_confidence = EXCLUDED.source_confidence,
          updated_at = now()
      `,
      [
        modelId,
        capability.process_type,
        textOrNull(capability.material_family),
        capability.capability_level ?? "supported",
        textOrNull(capability.notes),
        capability.source_confidence ?? "internal",
      ]
    );
  }
}

async function upsertMachineTooling(
  tx: DbQueryer,
  modelId: string,
  toolingRows: MachineOnboardingToolingInput[]
): Promise<void> {
  for (const tooling of toolingRows) {
    await tx.query(
      `
        INSERT INTO public.production_machine_tooling (
          machine_model_id,
          holder_type,
          spindle_taper,
          tool_family,
          compatible,
          notes,
          source_confidence
        )
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (machine_model_id, holder_type, (COALESCE(tool_family, ''))) DO UPDATE
        SET
          spindle_taper = COALESCE(EXCLUDED.spindle_taper, public.production_machine_tooling.spindle_taper),
          compatible = EXCLUDED.compatible,
          notes = COALESCE(EXCLUDED.notes, public.production_machine_tooling.notes),
          source_confidence = EXCLUDED.source_confidence,
          updated_at = now()
      `,
      [
        modelId,
        tooling.holder_type,
        textOrNull(tooling.spindle_taper),
        textOrNull(tooling.tool_family),
        tooling.compatible ?? true,
        textOrNull(tooling.notes),
        tooling.source_confidence ?? "internal",
      ]
    );
  }
}

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function toNullableInt(value: unknown, label = "id"): number | null {
  if (value === null || value === undefined) return null;
  return toInt(value, label);
}

function sortDir(dir: "asc" | "desc"): "ASC" | "DESC" {
  return dir === "asc" ? "ASC" : "DESC";
}

function machineSortColumn(sortBy: ListMachinesQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "m.created_at";
    case "code":
      return "m.code";
    case "name":
      return "m.name";
    case "updated_at":
    default:
      return "m.updated_at";
  }
}

export async function repoListMachines(filters: ListMachinesQueryDTO): Promise<Paginated<MachineListItem>> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (!filters.include_archived) {
    where.push("m.archived_at IS NULL");
  }

  if (filters.q && filters.q.trim().length > 0) {
    const q = `%${filters.q.trim()}%`;
    const p = push(q);
    where.push(`(
      m.code ILIKE ${p}
      OR m.name ILIKE ${p}
      OR COALESCE(m.brand,'') ILIKE ${p}
      OR COALESCE(m.model,'') ILIKE ${p}
      OR COALESCE(m.serial_number,'') ILIKE ${p}
    )`);
  }

  if (filters.type) where.push(`m.type = ${push(filters.type)}::machine_type`);
  if (filters.status) where.push(`m.status = ${push(filters.status)}::machine_status`);
  if (typeof filters.is_available === "boolean") where.push(`m.is_available = ${push(filters.is_available)}`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const countRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM machines m ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const orderBy = machineSortColumn(filters.sortBy);
  const orderDir = sortDir(filters.sortDir);

  type Row = {
    id: string;
    code: string;
    name: string;
    type: MachineListItem["type"];
    machine_model_id: string | null;
    model_display_name: string | null;
    manufacturer: string | null;
    model_name: string | null;
    display_name: string | null;
    status: MachineListItem["status"];
    hourly_rate: number | null;
    hourly_rate_source: MachineListItem["hourly_rate_source"];
    hourly_rate_effective_at: string | null;
    hourly_rate_is_override: boolean;
    currency: string;
    is_available: boolean;
    image_path: string | null;
    dashboard_color: string | null;
    model_3d_path: string | null;
    documentation_url: string | null;
    documentation_source: string | null;
    scheduling_enabled: boolean;
    outillage_enabled: boolean;
    archived_at: string | null;
    updated_at: string;
  };

  const dataRes = await pool.query<Row>(
    `
      SELECT
        m.id::text AS id,
        m.code,
        m.name,
        m.type::text AS type,
        m.machine_model_id::text AS machine_model_id,
        mm.display_name AS model_display_name,
        mm.manufacturer,
        mm.model AS model_name,
        m.display_name,
        m.status::text AS status,
        m.hourly_rate::float8 AS hourly_rate,
        m.hourly_rate_source,
        m.hourly_rate_effective_at::text AS hourly_rate_effective_at,
        m.hourly_rate_is_override,
        m.currency,
        m.is_available,
        m.image_path,
        m.dashboard_color,
        m.model_3d_path,
        m.documentation_url,
        m.documentation_source,
        m.scheduling_enabled,
        m.outillage_enabled,
        m.archived_at::text AS archived_at,
        m.updated_at::text AS updated_at
      FROM machines m
      LEFT JOIN public.production_machine_models mm ON mm.id = m.machine_model_id
      ${whereSql}
      ORDER BY ${orderBy} ${orderDir}, m.id ${orderDir}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  );

  const items: MachineListItem[] = dataRes.rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    machine_model_id: r.machine_model_id,
    model_display_name: r.model_display_name,
    manufacturer: r.manufacturer,
    model_name: r.model_name,
    display_name: r.display_name,
    status: r.status,
    hourly_rate: r.hourly_rate === null ? null : Number(r.hourly_rate),
    hourly_rate_source: r.hourly_rate_source,
    hourly_rate_effective_at: r.hourly_rate_effective_at,
    hourly_rate_is_override: r.hourly_rate_is_override,
    currency: r.currency,
    is_available: r.is_available,
    image_url: imageUrl(r.image_path),
    dashboard_color: r.dashboard_color,
    model_3d_path: r.model_3d_path,
    documentation_url: r.documentation_url,
    documentation_source: r.documentation_source,
    scheduling_enabled: r.scheduling_enabled,
    outillage_enabled: r.outillage_enabled,
    archived_at: r.archived_at,
    updated_at: r.updated_at,
  }));

  return { items, total };
}

export async function repoGetMachine(id: string): Promise<MachineDetail | null> {
  type Row = {
    id: string;
    code: string;
    name: string;
    type: MachineDetail["type"];
    status: MachineDetail["status"];
    machine_model_id: string | null;
    model_display_name: string | null;
    manufacturer: string | null;
    model_name: string | null;
    display_name: string | null;
    brand: string | null;
    model: string | null;
    serial_number: string | null;
    commissioned_year: number | null;
    image_path: string | null;
    hourly_rate: number | null;
    hourly_rate_source: MachineDetail["hourly_rate_source"];
    hourly_rate_effective_at: string | null;
    hourly_rate_is_override: boolean;
    currency: string;
    is_available: boolean;
    dashboard_color: string | null;
    model_3d_path: string | null;
    documentation_url: string | null;
    documentation_source: string | null;
    scheduling_enabled: boolean;
    outillage_enabled: boolean;
    location: string | null;
    workshop_zone: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
    created_by: number | null;
    updated_by: number | null;
    archived_at: string | null;
    archived_by: number | null;
  };

  const res = await pool.query<Row>(
    `
      SELECT
        m.id::text AS id,
        m.code,
        m.name,
        m.type::text AS type,
        m.status::text AS status,
        m.machine_model_id::text AS machine_model_id,
        mm.display_name AS model_display_name,
        mm.manufacturer,
        mm.model AS model_name,
        m.display_name,
        m.brand,
        m.model,
        m.serial_number,
        m.commissioned_year,
        m.image_path,
        m.hourly_rate::float8 AS hourly_rate,
        m.hourly_rate_source,
        m.hourly_rate_effective_at::text AS hourly_rate_effective_at,
        m.hourly_rate_is_override,
        m.currency,
        m.is_available,
        m.dashboard_color,
        m.model_3d_path,
        m.documentation_url,
        m.documentation_source,
        m.scheduling_enabled,
        m.outillage_enabled,
        m.location,
        m.workshop_zone,
        m.notes,
        m.created_at::text AS created_at,
        m.updated_at::text AS updated_at,
        m.created_by,
        m.updated_by,
        m.archived_at::text AS archived_at,
        m.archived_by
      FROM machines m
      LEFT JOIN public.production_machine_models mm ON mm.id = m.machine_model_id
      WHERE m.id = $1::uuid
      LIMIT 1
    `,
    [id]
  );
  const row = res.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    machine_model_id: row.machine_model_id,
    model_display_name: row.model_display_name,
    manufacturer: row.manufacturer,
    model_name: row.model_name,
    display_name: row.display_name,
    status: row.status,
    hourly_rate: row.hourly_rate === null ? null : Number(row.hourly_rate),
    hourly_rate_source: row.hourly_rate_source,
    hourly_rate_effective_at: row.hourly_rate_effective_at,
    hourly_rate_is_override: row.hourly_rate_is_override,
    currency: row.currency,
    is_available: row.is_available,
    image_url: imageUrl(row.image_path),
    image_path: row.image_path,
    dashboard_color: row.dashboard_color,
    model_3d_path: row.model_3d_path,
    documentation_url: row.documentation_url,
    documentation_source: row.documentation_source,
    scheduling_enabled: row.scheduling_enabled,
    outillage_enabled: row.outillage_enabled,
    brand: row.brand,
    model: row.model,
    serial_number: row.serial_number,
    commissioned_year: row.commissioned_year,
    location: row.location,
    workshop_zone: row.workshop_zone,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    archived_at: row.archived_at,
    archived_by: row.archived_by,
  };
}

export async function repoCreateMachine(params: {
  body: CreateMachineBodyDTO;
  image_path: string | null;
  idempotency_key?: string | null;
  audit: AuditContext;
}): Promise<MachineDetail> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    type Row = {
      id: string;
      code: string;
      name: string;
      type: MachineDetail["type"];
      status: MachineDetail["status"];
      machine_model_id: string | null;
      display_name: string | null;
      brand: string | null;
      model: string | null;
      serial_number: string | null;
      commissioned_year: number | null;
      image_path: string | null;
      hourly_rate: number | null;
      hourly_rate_source: MachineDetail["hourly_rate_source"];
      hourly_rate_effective_at: string | null;
      hourly_rate_is_override: boolean;
      currency: string;
      is_available: boolean;
      dashboard_color: string | null;
      model_3d_path: string | null;
      documentation_url: string | null;
      documentation_source: string | null;
      scheduling_enabled: boolean;
      outillage_enabled: boolean;
      location: string | null;
      workshop_zone: string | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
      created_by: number | null;
      updated_by: number | null;
      archived_at: string | null;
      archived_by: number | null;
    };

    const createdBy = params.audit.user_id;
    const updatedBy = params.audit.user_id;
    const b = params.body;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(b)).digest("hex");
    if (params.idempotency_key) {
      const replay = await client.query<{ machine_id: string; request_hash: string }>(
        `SELECT machine_id::text AS machine_id, request_hash FROM public.production_machine_idempotence WHERE idempotency_key = $1 FOR UPDATE`,
        [params.idempotency_key]
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with a different payload.");
        await client.query("COMMIT");
        const existing = await repoGetMachine(replay.rows[0].machine_id);
        if (!existing) throw new Error("Idempotent machine no longer exists");
        return existing;
      }
    }
    const code = await generateMachineCode(client);

    const ins = await client.query<Row>(
      `
        INSERT INTO machines (
          code,
          name,
          type,
          machine_model_id,
          display_name,
          brand,
          model,
          serial_number,
          commissioned_year,
          image_path,
          hourly_rate,
          hourly_rate_source,
          hourly_rate_effective_at,
          hourly_rate_is_override,
          currency,
          status,
          is_available,
          dashboard_color,
          model_3d_path,
          documentation_url,
          documentation_source,
          scheduling_enabled,
          outillage_enabled,
          location,
          workshop_zone,
          notes,
          created_by,
          updated_by
        )
        VALUES (
          $1,$2,$3::machine_type,$4::uuid,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16::machine_status,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
        )
        RETURNING
          id::text AS id,
          code,
          name,
          type::text AS type,
          status::text AS status,
          machine_model_id::text AS machine_model_id,
          display_name,
          brand,
          model,
          serial_number,
          commissioned_year,
          image_path,
          hourly_rate::float8 AS hourly_rate,
          hourly_rate_source,
          hourly_rate_effective_at::text AS hourly_rate_effective_at,
          hourly_rate_is_override,
          currency,
          is_available,
          dashboard_color,
          model_3d_path,
          documentation_url,
          documentation_source,
          scheduling_enabled,
          outillage_enabled,
          location,
          workshop_zone,
          notes,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by,
          archived_at::text AS archived_at,
          archived_by
      `,
      [
        code,
        b.name,
        b.type,
        b.machine_model_id ?? null,
        b.display_name ?? null,
        b.brand ?? null,
        b.model ?? null,
        b.serial_number ?? null,
        b.commissioned_year ?? null,
        params.image_path,
        b.hourly_rate,
        b.hourly_rate_source ?? null,
        b.hourly_rate_effective_at ?? null,
        b.hourly_rate_source === "MANUAL_OVERRIDE",
        b.currency,
        b.status,
        b.status === "ACTIVE",
        b.dashboard_color ?? null,
        b.model_3d_path ?? null,
        b.documentation_url ?? null,
        b.documentation_source ?? null,
        b.scheduling_enabled,
        b.outillage_enabled,
        b.location ?? null,
        b.workshop_zone ?? null,
        b.notes ?? null,
        createdBy,
        updatedBy,
      ]
    );

    const row = ins.rows[0];
    if (!row) throw new Error("Failed to create machine");

    if (params.idempotency_key) {
      await client.query(
        `INSERT INTO public.production_machine_idempotence (idempotency_key, request_hash, machine_id) VALUES ($1,$2,$3::uuid)`,
        [params.idempotency_key, requestHash, row.id]
      );
    }

    await insertAuditLog(client, params.audit, {
      action: "production.machines.create",
      entity_type: "machines",
      entity_id: row.id,
      details: {
        code: row.code,
        name: row.name,
        type: row.type,
        status: row.status,
      },
    });

    await client.query("COMMIT");

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      machine_model_id: row.machine_model_id,
      model_display_name: null,
      manufacturer: null,
      model_name: null,
      display_name: row.display_name,
      status: row.status,
      hourly_rate: row.hourly_rate === null ? null : Number(row.hourly_rate),
      hourly_rate_source: row.hourly_rate_source,
      hourly_rate_effective_at: row.hourly_rate_effective_at,
      hourly_rate_is_override: row.hourly_rate_is_override,
      currency: row.currency,
      is_available: row.is_available,
      image_url: imageUrl(row.image_path),
      image_path: row.image_path,
      dashboard_color: row.dashboard_color,
      model_3d_path: row.model_3d_path,
      documentation_url: row.documentation_url,
      documentation_source: row.documentation_source,
      scheduling_enabled: row.scheduling_enabled,
      outillage_enabled: row.outillage_enabled,
      archived_at: row.archived_at,
      updated_at: row.updated_at,
      brand: row.brand,
      model: row.model,
      serial_number: row.serial_number,
      commissioned_year: row.commissioned_year,
      location: row.location,
      workshop_zone: row.workshop_zone,
      notes: row.notes,
      created_at: row.created_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
      archived_by: row.archived_by,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "MACHINE_CODE_EXISTS", "A machine with this code already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoCreateMachineOnboarding(params: {
  body: CreateMachineOnboardingBodyDTO;
  image_path: string | null;
  idempotency_key?: string | null;
  audit: AuditContext;
}): Promise<MachineDetail> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const b = params.body;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(b)).digest("hex");
    if (params.idempotency_key) {
      const replay = await client.query<{ machine_id: string; request_hash: string }>(
        `SELECT machine_id::text AS machine_id, request_hash FROM public.production_machine_idempotence WHERE idempotency_key = $1 FOR UPDATE`,
        [params.idempotency_key]
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with a different payload.");
        await client.query("COMMIT");
        const replayMachine = await repoGetMachine(replay.rows[0].machine_id);
        if (!replayMachine) throw new Error("Idempotent machine no longer exists");
        return replayMachine;
      }
    }
    const modelInput = b.machine_model ?? null;
    const explicitMachineModelId = b.machine.machine_model_id ?? null;
    const explicitDraftModelId = modelInput?.id ?? null;

    if (explicitMachineModelId && explicitDraftModelId && explicitMachineModelId !== explicitDraftModelId) {
      throw new HttpError(400, "MACHINE_MODEL_MISMATCH", "Machine model identifiers do not match");
    }

    let resolvedModel: MachineModelMini | null = null;
    let resolvedModelId = explicitMachineModelId ?? explicitDraftModelId ?? null;

    if (resolvedModelId) {
      const existing = await client.query<MachineModelMini>(
        `
          SELECT
            id::text AS id,
            model_code,
            manufacturer,
            model,
            display_name
          FROM public.production_machine_models
          WHERE id = $1::uuid
          LIMIT 1
        `,
        [resolvedModelId]
      );
      resolvedModel = existing.rows[0] ?? null;
      if (!resolvedModel) {
        throw new HttpError(422, "MACHINE_MODEL_NOT_FOUND", "Machine model not found");
      }
    } else if (hasModelDraft(modelInput)) {
      const manufacturer = textOrNull(modelInput.manufacturer) ?? textOrNull(b.machine.brand);
      const modelName = textOrNull(modelInput.model) ?? textOrNull(b.machine.model);

      if (!manufacturer || !modelName) {
        throw new HttpError(422, "MACHINE_MODEL_IDENTITY_REQUIRED", "Manufacturer and model are required to create a machine model");
      }

      const displayName = textOrNull(modelInput.display_name) ?? `${manufacturer} ${modelName}`;
      const modelCode = textOrNull(modelInput.model_code) ?? makeMachineModelCode(manufacturer, modelName);

      const upsert = await client.query<MachineModelMini>(
        `
          INSERT INTO public.production_machine_models (
            model_code,
            manufacturer,
            model,
            display_name,
            machine_type,
            axes_count,
            description,
            source_summary,
            is_active
          )
          VALUES ($1,$2,$3,$4,$5::machine_type,$6,$7,$8,$9)
          ON CONFLICT (manufacturer, model) DO UPDATE
          SET
            display_name = EXCLUDED.display_name,
            machine_type = EXCLUDED.machine_type,
            axes_count = COALESCE(EXCLUDED.axes_count, public.production_machine_models.axes_count),
            description = COALESCE(EXCLUDED.description, public.production_machine_models.description),
            source_summary = COALESCE(EXCLUDED.source_summary, public.production_machine_models.source_summary),
            is_active = EXCLUDED.is_active,
            updated_at = now()
          RETURNING
            id::text AS id,
            model_code,
            manufacturer,
            model,
            display_name
        `,
        [
          modelCode,
          manufacturer,
          modelName,
          displayName,
          modelInput.machine_type ?? b.machine.type,
          modelInput.axes_count ?? null,
          textOrNull(modelInput.description),
          textOrNull(modelInput.source_summary),
          modelInput.is_active ?? true,
        ]
      );

      resolvedModel = upsert.rows[0] ?? null;
      resolvedModelId = resolvedModel?.id ?? null;
    }

    const wantsIntelligence = hasSpecDraft(b.specs) || (b.capabilities ?? []).length > 0 || (b.tooling ?? []).length > 0;
    if (wantsIntelligence && !resolvedModelId) {
      throw new HttpError(422, "MACHINE_MODEL_REQUIRED_FOR_INTELLIGENCE", "A machine model is required to persist specs, capabilities or tooling");
    }

    if (resolvedModelId && hasSpecDraft(b.specs)) {
      await upsertMachineSpecs(client, resolvedModelId, b.specs, "merge");
    }

    if (resolvedModelId) {
      await upsertMachineCapabilities(client, resolvedModelId, b.capabilities ?? []);
      await upsertMachineTooling(client, resolvedModelId, b.tooling ?? []);
    }

    type Row = {
      id: string;
      code: string;
      name: string;
      type: MachineDetail["type"];
      status: MachineDetail["status"];
      machine_model_id: string | null;
      display_name: string | null;
      brand: string | null;
      model: string | null;
      serial_number: string | null;
      commissioned_year: number | null;
      image_path: string | null;
      hourly_rate: number | null;
      hourly_rate_source: MachineDetail["hourly_rate_source"];
      hourly_rate_effective_at: string | null;
      hourly_rate_is_override: boolean;
      currency: string;
      is_available: boolean;
      dashboard_color: string | null;
      model_3d_path: string | null;
      documentation_url: string | null;
      documentation_source: string | null;
      scheduling_enabled: boolean;
      outillage_enabled: boolean;
      location: string | null;
      workshop_zone: string | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
      created_by: number | null;
      updated_by: number | null;
      archived_at: string | null;
      archived_by: number | null;
    };

    const machine = b.machine;
    const code = await generateMachineCode(client);
    const ins = await client.query<Row>(
      `
        INSERT INTO machines (
          code,
          name,
          type,
          machine_model_id,
          display_name,
          brand,
          model,
          serial_number,
          commissioned_year,
          image_path,
          hourly_rate,
          hourly_rate_source,
          hourly_rate_effective_at,
          hourly_rate_is_override,
          currency,
          status,
          is_available,
          dashboard_color,
          model_3d_path,
          documentation_url,
          documentation_source,
          scheduling_enabled,
          outillage_enabled,
          location,
          workshop_zone,
          notes,
          created_by,
          updated_by
        )
        VALUES (
          $1,$2,$3::machine_type,$4::uuid,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16::machine_status,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
        )
        RETURNING
          id::text AS id,
          code,
          name,
          type::text AS type,
          status::text AS status,
          machine_model_id::text AS machine_model_id,
          display_name,
          brand,
          model,
          serial_number,
          commissioned_year,
          image_path,
          hourly_rate::float8 AS hourly_rate,
          hourly_rate_source,
          hourly_rate_effective_at::text AS hourly_rate_effective_at,
          hourly_rate_is_override,
          currency,
          is_available,
          dashboard_color,
          model_3d_path,
          documentation_url,
          documentation_source,
          scheduling_enabled,
          outillage_enabled,
          location,
          workshop_zone,
          notes,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by,
          archived_at::text AS archived_at,
          archived_by
      `,
      [
        code,
        machine.name,
        machine.type,
        resolvedModelId,
        machine.display_name ?? null,
        machine.brand ?? resolvedModel?.manufacturer ?? null,
        machine.model ?? resolvedModel?.model ?? null,
        machine.serial_number ?? null,
        machine.commissioned_year ?? null,
        params.image_path,
        machine.hourly_rate,
        machine.hourly_rate_source ?? null,
        machine.hourly_rate_effective_at ?? null,
        machine.hourly_rate_source === "MANUAL_OVERRIDE",
        machine.currency,
        machine.status,
        machine.status === "ACTIVE",
        machine.dashboard_color ?? null,
        machine.model_3d_path ?? null,
        machine.documentation_url ?? null,
        machine.documentation_source ?? null,
        machine.scheduling_enabled,
        machine.outillage_enabled,
        machine.location ?? null,
        machine.workshop_zone ?? null,
        machine.notes ?? null,
        params.audit.user_id,
        params.audit.user_id,
      ]
    );

    const row = ins.rows[0];
    if (!row) throw new Error("Failed to create machine from onboarding");

    if (params.idempotency_key) {
      await client.query(
        `INSERT INTO public.production_machine_idempotence (idempotency_key, request_hash, machine_id) VALUES ($1,$2,$3::uuid)`,
        [params.idempotency_key, requestHash, row.id]
      );
    }

    await insertAuditLog(client, params.audit, {
      action: "production.machines.onboarding.create",
      entity_type: "machines",
      entity_id: row.id,
      details: {
        code: row.code,
        name: row.name,
        type: row.type,
        status: row.status,
        machine_model_id: resolvedModelId,
        specs_written: hasSpecDraft(b.specs),
        capabilities_count: b.capabilities?.length ?? 0,
        tooling_count: b.tooling?.length ?? 0,
      },
    });

    await client.query("COMMIT");

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      machine_model_id: row.machine_model_id,
      model_display_name: resolvedModel?.display_name ?? null,
      manufacturer: resolvedModel?.manufacturer ?? null,
      model_name: resolvedModel?.model ?? null,
      display_name: row.display_name,
      status: row.status,
      hourly_rate: row.hourly_rate === null ? null : Number(row.hourly_rate),
      hourly_rate_source: row.hourly_rate_source,
      hourly_rate_effective_at: row.hourly_rate_effective_at,
      hourly_rate_is_override: row.hourly_rate_is_override,
      currency: row.currency,
      is_available: row.is_available,
      image_url: imageUrl(row.image_path),
      image_path: row.image_path,
      dashboard_color: row.dashboard_color,
      model_3d_path: row.model_3d_path,
      documentation_url: row.documentation_url,
      documentation_source: row.documentation_source,
      scheduling_enabled: row.scheduling_enabled,
      outillage_enabled: row.outillage_enabled,
      archived_at: row.archived_at,
      updated_at: row.updated_at,
      brand: row.brand,
      model: row.model,
      serial_number: row.serial_number,
      commissioned_year: row.commissioned_year,
      location: row.location,
      workshop_zone: row.workshop_zone,
      notes: row.notes,
      created_at: row.created_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
      archived_by: row.archived_by,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      const constraint = pgConstraint(err);
      if (constraint === "machines_code_key") {
        throw new HttpError(409, "MACHINE_CODE_EXISTS", "A machine with this code already exists");
      }
      if (constraint === "production_machine_models_code_key") {
        throw new HttpError(409, "MACHINE_MODEL_CODE_EXISTS", "A machine model with this code already exists");
      }
      throw new HttpError(409, "MACHINE_ONBOARDING_UNIQUE_CONFLICT", "Machine onboarding conflicts with existing data");
    }
    if (isPgForeignKeyViolation(err)) {
      throw new HttpError(422, "MACHINE_ONBOARDING_REFERENCE_INVALID", "Machine onboarding references invalid data");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateMachineOnboarding(params: {
  id: string;
  body: UpdateMachineOnboardingBodyDTO;
  image_path?: string | null;
  audit: AuditContext;
}): Promise<MachineDetail | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existingMachine = await client.query<{
      id: string;
      code: string;
      name: string;
      type: string;
      status: string;
      machine_model_id: string | null;
      serial_number: string | null;
      commissioned_year: number | null;
      location: string | null;
      workshop_zone: string | null;
      archived_at: string | null;
      updated_at: string;
    }>(
      `
        SELECT
          id::text AS id,
          code,
          name,
          type::text AS type,
          status::text AS status,
          machine_model_id::text AS machine_model_id,
          serial_number,
          commissioned_year,
          location,
          workshop_zone,
          archived_at::text AS archived_at,
          updated_at::text AS updated_at
        FROM machines
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [params.id]
    );
    const existing = existingMachine.rows[0] ?? null;
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }
    if (existing.archived_at) {
      throw new HttpError(409, "MACHINE_ARCHIVED", "Archived machine cannot be edited");
    }
    if (existing.updated_at !== params.body.machine.expected_updated_at) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Machine has been modified by another user.");
    }

    const b = params.body;
    const machine = b.machine;
    const modelInput = b.machine_model ?? null;
    const hasMachineModelIdField = Object.prototype.hasOwnProperty.call(machine, "machine_model_id");
    const explicitMachineModelId = hasMachineModelIdField ? machine.machine_model_id ?? null : undefined;
    const explicitDraftModelId = modelInput?.id ?? null;

    if (explicitMachineModelId && explicitDraftModelId && explicitMachineModelId !== explicitDraftModelId) {
      throw new HttpError(400, "MACHINE_MODEL_MISMATCH", "Machine model identifiers do not match");
    }

    let resolvedModel: MachineModelMini | null = null;
    let sharedModelBeforeAudit: MachineModelMini | null = null;
    let resolvedModelId =
      explicitMachineModelId !== undefined
        ? explicitMachineModelId
        : explicitDraftModelId ?? existing.machine_model_id ?? null;

    if (resolvedModelId) {
      const currentModel = await selectMachineModelMini(client, resolvedModelId);
      if (!currentModel) {
        throw new HttpError(422, "MACHINE_MODEL_NOT_FOUND", "Machine model not found");
      }

      if (hasModelDraft(modelInput)) {
        sharedModelBeforeAudit = currentModel;
        if (!b.update_shared_model) {
          throw new HttpError(422, "SHARED_MODEL_CONFIRMATION_REQUIRED", "Explicit confirmation is required before updating a shared machine model.");
        }
        if (!b.expected_model_updated_at || currentModel.updated_at !== b.expected_model_updated_at) {
          throw new HttpError(409, "CONCURRENT_MODEL_MODIFICATION", "The shared machine model has changed. Reload before saving.");
        }
        const manufacturer = textOrNull(modelInput.manufacturer) ?? currentModel.manufacturer ?? textOrNull(machine.brand);
        const modelName = textOrNull(modelInput.model) ?? currentModel.model ?? textOrNull(machine.model);
        if (!manufacturer || !modelName) {
          throw new HttpError(422, "MACHINE_MODEL_IDENTITY_REQUIRED", "Manufacturer and model are required to update a machine model");
        }

        const updatedModel = await client.query<MachineModelMini>(
          `
            UPDATE public.production_machine_models
            SET
              model_code = $2,
              manufacturer = $3,
              model = $4,
              display_name = $5,
              machine_type = $6::machine_type,
              axes_count = COALESCE($7, axes_count),
              description = COALESCE($8, description),
              source_summary = COALESCE($9, source_summary),
              is_active = COALESCE($10, is_active),
              updated_at = now()
            WHERE id = $1::uuid AND updated_at::text = $11
            RETURNING
              id::text AS id,
              model_code,
              manufacturer,
              model,
              display_name,
              updated_at::text AS updated_at
          `,
          [
            resolvedModelId,
            textOrNull(modelInput.model_code) ?? currentModel.model_code,
            manufacturer,
            modelName,
            textOrNull(modelInput.display_name) ?? currentModel.display_name ?? `${manufacturer} ${modelName}`,
            modelInput.machine_type ?? machine.type,
            modelInput.axes_count ?? null,
            textOrNull(modelInput.description),
            textOrNull(modelInput.source_summary),
            modelInput.is_active ?? null,
            b.expected_model_updated_at,
          ]
        );
        resolvedModel = updatedModel.rows[0] ?? null;
        if (!resolvedModel) {
          throw new HttpError(409, "CONCURRENT_MODEL_MODIFICATION", "The shared machine model has changed. Reload before saving.");
        }
      } else {
        resolvedModel = currentModel;
      }
    } else if (hasModelDraft(modelInput)) {
      const manufacturer = textOrNull(modelInput.manufacturer) ?? textOrNull(machine.brand);
      const modelName = textOrNull(modelInput.model) ?? textOrNull(machine.model);

      if (!manufacturer || !modelName) {
        throw new HttpError(422, "MACHINE_MODEL_IDENTITY_REQUIRED", "Manufacturer and model are required to create a machine model");
      }

      const displayName = textOrNull(modelInput.display_name) ?? `${manufacturer} ${modelName}`;
      const modelCode = textOrNull(modelInput.model_code) ?? makeMachineModelCode(manufacturer, modelName);

      const upsert = await client.query<MachineModelMini>(
        `
          INSERT INTO public.production_machine_models (
            model_code,
            manufacturer,
            model,
            display_name,
            machine_type,
            axes_count,
            description,
            source_summary,
            is_active
          )
          VALUES ($1,$2,$3,$4,$5::machine_type,$6,$7,$8,$9)
          ON CONFLICT (manufacturer, model) DO UPDATE
          SET
            display_name = EXCLUDED.display_name,
            machine_type = EXCLUDED.machine_type,
            axes_count = COALESCE(EXCLUDED.axes_count, public.production_machine_models.axes_count),
            description = COALESCE(EXCLUDED.description, public.production_machine_models.description),
            source_summary = COALESCE(EXCLUDED.source_summary, public.production_machine_models.source_summary),
            is_active = EXCLUDED.is_active,
            updated_at = now()
          RETURNING
            id::text AS id,
            model_code,
            manufacturer,
            model,
            display_name
        `,
        [
          modelCode,
          manufacturer,
          modelName,
          displayName,
          modelInput.machine_type ?? machine.type,
          modelInput.axes_count ?? null,
          textOrNull(modelInput.description),
          textOrNull(modelInput.source_summary),
          modelInput.is_active ?? true,
        ]
      );

      resolvedModel = upsert.rows[0] ?? null;
      resolvedModelId = resolvedModel?.id ?? null;
    }

    const wantsIntelligence = hasSpecDraft(b.specs) || (b.capabilities ?? []).length > 0 || (b.tooling ?? []).length > 0;
    if (wantsIntelligence && !resolvedModelId) {
      throw new HttpError(422, "MACHINE_MODEL_REQUIRED_FOR_INTELLIGENCE", "A machine model is required to persist specs, capabilities or tooling");
    }

    const sharedDataMutationRequested = hasSpecDraft(b.specs) || (b.capabilities ?? []).length > 0 || (b.tooling ?? []).length > 0;
    if (existing.machine_model_id && sharedDataMutationRequested && !b.update_shared_model) {
      throw new HttpError(422, "SHARED_MODEL_CONFIRMATION_REQUIRED", "Explicit confirmation is required before updating shared specifications, capabilities or tooling.");
    }
    if (
      existing.machine_model_id &&
      sharedDataMutationRequested &&
      !hasModelDraft(modelInput) &&
      (!b.expected_model_updated_at || resolvedModel?.updated_at !== b.expected_model_updated_at)
    ) {
      throw new HttpError(409, "CONCURRENT_MODEL_MODIFICATION", "The shared machine model has changed. Reload before saving.");
    }

    if (resolvedModelId && hasSpecDraft(b.specs)) {
      await upsertMachineSpecs(client, resolvedModelId, b.specs, "replace");
    }

    if (resolvedModelId) {
      await upsertMachineCapabilities(client, resolvedModelId, b.capabilities ?? []);
      await upsertMachineTooling(client, resolvedModelId, b.tooling ?? []);
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    sets.push(`name = ${push(machine.name)}`);
    sets.push(`type = ${push(machine.type)}::machine_type`);
    sets.push(`machine_model_id = ${push(resolvedModelId)}::uuid`);
    sets.push(`display_name = ${push(machine.display_name ?? null)}`);
    sets.push(`brand = ${push(machine.brand ?? resolvedModel?.manufacturer ?? null)}`);
    sets.push(`model = ${push(machine.model ?? resolvedModel?.model ?? null)}`);
    sets.push(`serial_number = ${push(machine.serial_number ?? null)}`);
    sets.push(`commissioned_year = ${push(machine.commissioned_year ?? null)}`);
    sets.push(`hourly_rate = ${push(machine.hourly_rate)}`);
    sets.push(`hourly_rate_source = ${push(machine.hourly_rate_source ?? null)}`);
    sets.push(`hourly_rate_effective_at = ${push(machine.hourly_rate_effective_at ?? null)}::date`);
    sets.push(`hourly_rate_is_override = ${push(machine.hourly_rate_source === "MANUAL_OVERRIDE")}`);
    sets.push(`currency = ${push(machine.currency)}`);
    sets.push(`status = ${push(machine.status)}::machine_status`);
    sets.push(`is_available = ${push(machine.status === "ACTIVE")}`);
    sets.push(`dashboard_color = ${push(machine.dashboard_color ?? null)}`);
    sets.push(`model_3d_path = ${push(machine.model_3d_path ?? null)}`);
    sets.push(`documentation_url = ${push(machine.documentation_url ?? null)}`);
    sets.push(`documentation_source = ${push(machine.documentation_source ?? null)}`);
    sets.push(`scheduling_enabled = ${push(machine.scheduling_enabled)}`);
    sets.push(`outillage_enabled = ${push(machine.outillage_enabled)}`);
    sets.push(`location = ${push(machine.location ?? null)}`);
    sets.push(`workshop_zone = ${push(machine.workshop_zone ?? null)}`);
    sets.push(`notes = ${push(machine.notes ?? null)}`);
    if (params.image_path !== undefined) {
      sets.push(`image_path = ${push(params.image_path)}`);
    }
    sets.push(`updated_by = ${push(params.audit.user_id)}`);
    sets.push(`updated_at = now()`);

    const upd = await client.query<{
      id: string;
      code: string;
      name: string;
      type: string;
      status: string;
      machine_model_id: string | null;
      serial_number: string | null;
      commissioned_year: number | null;
      location: string | null;
      workshop_zone: string | null;
    }>(
      `
        UPDATE machines
        SET ${sets.join(", ")}
        WHERE id = ${push(params.id)}::uuid
          AND updated_at::text = ${push(machine.expected_updated_at)}
        RETURNING
          id::text AS id,
          code,
          name,
          type::text AS type,
          status::text AS status,
          machine_model_id::text AS machine_model_id,
          serial_number,
          commissioned_year,
          location,
          workshop_zone
      `,
      values
    );

    const row = upd.rows[0] ?? null;
    if (!row) throw new HttpError(409, "CONCURRENT_MODIFICATION", "Machine has been modified by another user.");

    await insertAuditLog(client, params.audit, {
      action: "production.machines.onboarding.update",
      entity_type: "machines",
      entity_id: row.id,
      details: {
        before: {
          code: existing.code,
          name: existing.name,
          type: existing.type,
          status: existing.status,
          machine_model_id: existing.machine_model_id,
          serial_number: existing.serial_number,
          commissioned_year: existing.commissioned_year,
          location: existing.location,
          workshop_zone: existing.workshop_zone,
        },
        after: {
          code: row.code,
          name: row.name,
          type: row.type,
          status: row.status,
          machine_model_id: row.machine_model_id,
          serial_number: row.serial_number,
          commissioned_year: row.commissioned_year,
          location: row.location,
          workshop_zone: row.workshop_zone,
        },
        shared_model_before: sharedModelBeforeAudit,
        shared_model_after: sharedModelBeforeAudit ? resolvedModel : null,
        redacted_fields: ["hourly_rate", "hourly_rate_source", "hourly_rate_effective_at", "notes"],
        model_updated: hasModelDraft(modelInput),
        specs_written: hasSpecDraft(b.specs),
        capabilities_count: b.capabilities?.length ?? 0,
        tooling_count: b.tooling?.length ?? 0,
      },
    });

    await client.query("COMMIT");

    const out = await repoGetMachine(row.id);
    if (!out) throw new Error("Failed to load updated machine");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      const constraint = pgConstraint(err);
      if (constraint === "machines_code_key") {
        throw new HttpError(409, "MACHINE_CODE_EXISTS", "A machine with this code already exists");
      }
      if (constraint === "production_machine_models_code_key") {
        throw new HttpError(409, "MACHINE_MODEL_CODE_EXISTS", "A machine model with this code already exists");
      }
      if (constraint === "production_machine_models_manufacturer_model_key") {
        throw new HttpError(409, "MACHINE_MODEL_EXISTS", "A machine model with this manufacturer and model already exists");
      }
      throw new HttpError(409, "MACHINE_ONBOARDING_UNIQUE_CONFLICT", "Machine onboarding conflicts with existing data");
    }
    if (isPgForeignKeyViolation(err)) {
      throw new HttpError(422, "MACHINE_ONBOARDING_REFERENCE_INVALID", "Machine onboarding references invalid data");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateMachine(params: {
  id: string;
  patch: UpdateMachineBodyDTO;
  image_path?: string | null;
  audit: AuditContext;
}): Promise<MachineDetail | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await client.query<{ id: string; archived_at: string | null; updated_at: string }>(
      `SELECT id::text AS id, archived_at::text AS archived_at, updated_at::text AS updated_at FROM machines WHERE id = $1::uuid FOR UPDATE`,
      [params.id]
    );
    const existing = before.rows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }
    if (existing.archived_at) {
      throw new HttpError(409, "MACHINE_ARCHIVED", "Archived machine cannot be edited");
    }
    if (existing.updated_at !== params.patch.expected_updated_at) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Machine has been modified by another user.");
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    const p = params.patch;
    if (p.name !== undefined) sets.push(`name = ${push(p.name)}`);
    if (p.type !== undefined) sets.push(`type = ${push(p.type)}::machine_type`);
    if (p.machine_model_id !== undefined) sets.push(`machine_model_id = ${push(p.machine_model_id ?? null)}::uuid`);
    if (p.display_name !== undefined) sets.push(`display_name = ${push(p.display_name ?? null)}`);
    if (p.brand !== undefined) sets.push(`brand = ${push(p.brand ?? null)}`);
    if (p.model !== undefined) sets.push(`model = ${push(p.model ?? null)}`);
    if (p.serial_number !== undefined) sets.push(`serial_number = ${push(p.serial_number ?? null)}`);
    if (p.commissioned_year !== undefined) sets.push(`commissioned_year = ${push(p.commissioned_year ?? null)}`);
    if (p.hourly_rate !== undefined) sets.push(`hourly_rate = ${push(p.hourly_rate)}`);
    if (p.hourly_rate_source !== undefined) {
      sets.push(`hourly_rate_source = ${push(p.hourly_rate_source)}`);
      sets.push(`hourly_rate_is_override = ${push(p.hourly_rate_source === "MANUAL_OVERRIDE")}`);
    }
    if (p.hourly_rate_effective_at !== undefined) sets.push(`hourly_rate_effective_at = ${push(p.hourly_rate_effective_at)}::date`);
    if (p.currency !== undefined) sets.push(`currency = ${push(p.currency)}`);
    if (p.status !== undefined) sets.push(`status = ${push(p.status)}::machine_status`);
    if (p.status !== undefined) sets.push(`is_available = ${push(p.status === "ACTIVE")}`);
    if (p.dashboard_color !== undefined) sets.push(`dashboard_color = ${push(p.dashboard_color ?? null)}`);
    if (p.model_3d_path !== undefined) sets.push(`model_3d_path = ${push(p.model_3d_path ?? null)}`);
    if (p.documentation_url !== undefined) sets.push(`documentation_url = ${push(p.documentation_url ?? null)}`);
    if (p.documentation_source !== undefined) sets.push(`documentation_source = ${push(p.documentation_source ?? null)}`);
    if (p.scheduling_enabled !== undefined) sets.push(`scheduling_enabled = ${push(p.scheduling_enabled)}`);
    if (p.outillage_enabled !== undefined) sets.push(`outillage_enabled = ${push(p.outillage_enabled)}`);
    if (p.location !== undefined) sets.push(`location = ${push(p.location ?? null)}`);
    if (p.workshop_zone !== undefined) sets.push(`workshop_zone = ${push(p.workshop_zone ?? null)}`);
    if (p.notes !== undefined) sets.push(`notes = ${push(p.notes ?? null)}`);

    if (params.image_path !== undefined) {
      sets.push(`image_path = ${push(params.image_path)}`);
    }

    sets.push(`updated_by = ${push(params.audit.user_id)}`);
    sets.push(`updated_at = now()`);

    type Row = {
      id: string;
      code: string;
      name: string;
      type: MachineDetail["type"];
      status: MachineDetail["status"];
      machine_model_id: string | null;
      display_name: string | null;
      brand: string | null;
      model: string | null;
      serial_number: string | null;
      commissioned_year: number | null;
      image_path: string | null;
      hourly_rate: number | null;
      hourly_rate_source: MachineDetail["hourly_rate_source"];
      hourly_rate_effective_at: string | null;
      hourly_rate_is_override: boolean;
      currency: string;
      is_available: boolean;
      dashboard_color: string | null;
      model_3d_path: string | null;
      documentation_url: string | null;
      documentation_source: string | null;
      scheduling_enabled: boolean;
      outillage_enabled: boolean;
      location: string | null;
      workshop_zone: string | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
      created_by: number | null;
      updated_by: number | null;
      archived_at: string | null;
      archived_by: number | null;
    };

    const upd = await client.query<Row>(
      `
        UPDATE machines
        SET ${sets.join(", ")}
        WHERE id = ${push(params.id)}::uuid
          AND updated_at::text = ${push(p.expected_updated_at)}
        RETURNING
          id::text AS id,
          code,
          name,
          type::text AS type,
          status::text AS status,
          machine_model_id::text AS machine_model_id,
          display_name,
          brand,
          model,
          serial_number,
          commissioned_year,
          image_path,
          hourly_rate::float8 AS hourly_rate,
          hourly_rate_source,
          hourly_rate_effective_at::text AS hourly_rate_effective_at,
          hourly_rate_is_override,
          currency,
          is_available,
          dashboard_color,
          model_3d_path,
          documentation_url,
          documentation_source,
          scheduling_enabled,
          outillage_enabled,
          location,
          workshop_zone,
          notes,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by,
          archived_at::text AS archived_at,
          archived_by
      `,
      values
    );

    const row = upd.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    await insertAuditLog(client, params.audit, {
      action: "production.machines.update",
      entity_type: "machines",
      entity_id: row.id,
      details: {
        code: row.code,
        name: row.name,
      },
    });

    await client.query("COMMIT");

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      machine_model_id: row.machine_model_id,
      model_display_name: null,
      manufacturer: null,
      model_name: null,
      display_name: row.display_name,
      status: row.status,
      hourly_rate: row.hourly_rate === null ? null : Number(row.hourly_rate),
      hourly_rate_source: row.hourly_rate_source,
      hourly_rate_effective_at: row.hourly_rate_effective_at,
      hourly_rate_is_override: row.hourly_rate_is_override,
      currency: row.currency,
      is_available: row.is_available,
      image_url: imageUrl(row.image_path),
      image_path: row.image_path,
      dashboard_color: row.dashboard_color,
      model_3d_path: row.model_3d_path,
      documentation_url: row.documentation_url,
      documentation_source: row.documentation_source,
      scheduling_enabled: row.scheduling_enabled,
      outillage_enabled: row.outillage_enabled,
      archived_at: row.archived_at,
      updated_at: row.updated_at,
      brand: row.brand,
      model: row.model,
      serial_number: row.serial_number,
      commissioned_year: row.commissioned_year,
      location: row.location,
      workshop_zone: row.workshop_zone,
      notes: row.notes,
      created_at: row.created_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
      archived_by: row.archived_by,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "MACHINE_CODE_EXISTS", "A machine with this code already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoArchiveMachine(params: { id: string; audit: AuditContext }): Promise<boolean | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM machines WHERE id = $1::uuid FOR UPDATE`,
      [params.id]
    );
    if (!exists.rows[0]?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    const upd = await client.query(
      `
        UPDATE machines
        SET archived_at = now(), archived_by = $2, updated_at = now(), updated_by = $2
        WHERE id = $1::uuid AND archived_at IS NULL
      `,
      [params.id, params.audit.user_id]
    );

    await insertAuditLog(client, params.audit, {
      action: "production.machines.archive",
      entity_type: "machines",
      entity_id: params.id,
    });

    await client.query("COMMIT");
    return (upd.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function posteSortColumn(sortBy: ListPostesQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "p.created_at";
    case "code":
      return "p.code";
    case "label":
      return "p.label";
    case "updated_at":
    default:
      return "p.updated_at";
  }
}

export async function repoListPostes(filters: ListPostesQueryDTO): Promise<Paginated<PosteListItem>> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (!filters.include_archived) {
    where.push("p.archived_at IS NULL");
  }

  if (filters.q && filters.q.trim().length > 0) {
    const q = `%${filters.q.trim()}%`;
    const p = push(q);
    where.push(`(p.code ILIKE ${p} OR p.label ILIKE ${p})`);
  }

  if (filters.machine_id) where.push(`p.machine_id = ${push(filters.machine_id)}::uuid`);
  if (typeof filters.is_active === "boolean") where.push(`p.is_active = ${push(filters.is_active)}`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const countRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM postes p ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const orderBy = posteSortColumn(filters.sortBy);
  const orderDir = sortDir(filters.sortDir);

  type Row = {
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

  const dataRes = await pool.query<Row>(
    `
      SELECT
        p.id::text AS id,
        p.code,
        p.label,
        p.machine_id::text AS machine_id,
        p.hourly_rate_override::float8 AS hourly_rate_override,
        p.currency,
        p.is_active,
        p.archived_at::text AS archived_at,
        p.updated_at::text AS updated_at
      FROM postes p
      ${whereSql}
      ORDER BY ${orderBy} ${orderDir}, p.id ${orderDir}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  );

  const items: PosteListItem[] = dataRes.rows.map((r) => ({
    id: r.id,
    code: r.code,
    label: r.label,
    machine_id: r.machine_id,
    hourly_rate_override: r.hourly_rate_override === null ? null : Number(r.hourly_rate_override),
    currency: r.currency,
    is_active: r.is_active,
    archived_at: r.archived_at,
    updated_at: r.updated_at,
  }));

  return { items, total };
}

export async function repoGetPoste(id: string): Promise<PosteDetail | null> {
  type Row = {
    id: string;
    code: string;
    label: string;
    machine_id: string | null;
    hourly_rate_override: number | null;
    currency: string;
    is_active: boolean;
    notes: string | null;
    created_at: string;
    updated_at: string;
    created_by: number | null;
    updated_by: number | null;
    archived_at: string | null;
    archived_by: number | null;
  };

  const res = await pool.query<Row>(
    `
      SELECT
        p.id::text AS id,
        p.code,
        p.label,
        p.machine_id::text AS machine_id,
        p.hourly_rate_override::float8 AS hourly_rate_override,
        p.currency,
        p.is_active,
        p.notes,
        p.created_at::text AS created_at,
        p.updated_at::text AS updated_at,
        p.created_by,
        p.updated_by,
        p.archived_at::text AS archived_at,
        p.archived_by
      FROM postes p
      WHERE p.id = $1::uuid
      LIMIT 1
    `,
    [id]
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    code: row.code,
    label: row.label,
    machine_id: row.machine_id,
    hourly_rate_override: row.hourly_rate_override === null ? null : Number(row.hourly_rate_override),
    currency: row.currency,
    is_active: row.is_active,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    archived_at: row.archived_at,
    archived_by: row.archived_by,
  };
}

export async function repoCreatePoste(params: {
  body: CreatePosteBodyDTO;
  audit: AuditContext;
}): Promise<PosteDetail> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    type Row = {
      id: string;
      code: string;
      label: string;
      machine_id: string | null;
      hourly_rate_override: number | null;
      currency: string;
      is_active: boolean;
      notes: string | null;
      created_at: string;
      updated_at: string;
      created_by: number | null;
      updated_by: number | null;
      archived_at: string | null;
      archived_by: number | null;
    };

    const createdBy = params.audit.user_id;
    const updatedBy = params.audit.user_id;
    const b = params.body;
    const ins = await client.query<Row>(
      `
        INSERT INTO postes (
          code,
          label,
          machine_id,
          hourly_rate_override,
          currency,
          is_active,
          notes,
          created_by,
          updated_by
        )
        VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9)
        RETURNING
          id::text AS id,
          code,
          label,
          machine_id::text AS machine_id,
          hourly_rate_override::float8 AS hourly_rate_override,
          currency,
          is_active,
          notes,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by,
          archived_at::text AS archived_at,
          archived_by
      `,
      [
        b.code,
        b.label,
        b.machine_id ?? null,
        b.hourly_rate_override ?? null,
        b.currency,
        b.is_active,
        b.notes ?? null,
        createdBy,
        updatedBy,
      ]
    );

    const row = ins.rows[0];
    if (!row) throw new Error("Failed to create poste");

    await insertAuditLog(client, params.audit, {
      action: "production.postes.create",
      entity_type: "postes",
      entity_id: row.id,
      details: { code: row.code, label: row.label },
    });

    await client.query("COMMIT");

    return {
      id: row.id,
      code: row.code,
      label: row.label,
      machine_id: row.machine_id,
      hourly_rate_override: row.hourly_rate_override === null ? null : Number(row.hourly_rate_override),
      currency: row.currency,
      is_active: row.is_active,
      archived_at: row.archived_at,
      updated_at: row.updated_at,
      notes: row.notes,
      created_at: row.created_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
      archived_by: row.archived_by,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "POSTE_CODE_EXISTS", "A poste with this code already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdatePoste(params: {
  id: string;
  patch: UpdatePosteBodyDTO;
  audit: AuditContext;
}): Promise<PosteDetail | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await client.query<{ id: string; archived_at: string | null }>(
      `SELECT id::text AS id, archived_at::text AS archived_at FROM postes WHERE id = $1::uuid FOR UPDATE`,
      [params.id]
    );
    const existing = before.rows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }
    if (existing.archived_at) {
      throw new HttpError(409, "POSTE_ARCHIVED", "Archived poste cannot be edited");
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    const p = params.patch;
    if (p.code !== undefined) sets.push(`code = ${push(p.code)}`);
    if (p.label !== undefined) sets.push(`label = ${push(p.label)}`);
    if (p.machine_id !== undefined) sets.push(`machine_id = ${push(p.machine_id ?? null)}::uuid`);
    if (p.hourly_rate_override !== undefined) sets.push(`hourly_rate_override = ${push(p.hourly_rate_override ?? null)}`);
    if (p.currency !== undefined) sets.push(`currency = ${push(p.currency)}`);
    if (p.is_active !== undefined) sets.push(`is_active = ${push(p.is_active)}`);
    if (p.notes !== undefined) sets.push(`notes = ${push(p.notes ?? null)}`);

    sets.push(`updated_by = ${push(params.audit.user_id)}`);
    sets.push(`updated_at = now()`);

    type Row = {
      id: string;
      code: string;
      label: string;
      machine_id: string | null;
      hourly_rate_override: number | null;
      currency: string;
      is_active: boolean;
      notes: string | null;
      created_at: string;
      updated_at: string;
      created_by: number | null;
      updated_by: number | null;
      archived_at: string | null;
      archived_by: number | null;
    };

    const upd = await client.query<Row>(
      `
        UPDATE postes
        SET ${sets.join(", ")}
        WHERE id = ${push(params.id)}::uuid
        RETURNING
          id::text AS id,
          code,
          label,
          machine_id::text AS machine_id,
          hourly_rate_override::float8 AS hourly_rate_override,
          currency,
          is_active,
          notes,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          created_by,
          updated_by,
          archived_at::text AS archived_at,
          archived_by
      `,
      values
    );
    const row = upd.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    await insertAuditLog(client, params.audit, {
      action: "production.postes.update",
      entity_type: "postes",
      entity_id: row.id,
      details: { code: row.code, label: row.label },
    });

    await client.query("COMMIT");

    return {
      id: row.id,
      code: row.code,
      label: row.label,
      machine_id: row.machine_id,
      hourly_rate_override: row.hourly_rate_override === null ? null : Number(row.hourly_rate_override),
      currency: row.currency,
      is_active: row.is_active,
      archived_at: row.archived_at,
      updated_at: row.updated_at,
      notes: row.notes,
      created_at: row.created_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
      archived_by: row.archived_by,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "POSTE_CODE_EXISTS", "A poste with this code already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoArchivePoste(params: { id: string; audit: AuditContext }): Promise<boolean | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM postes WHERE id = $1::uuid FOR UPDATE`,
      [params.id]
    );
    if (!exists.rows[0]?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    const upd = await client.query(
      `
        UPDATE postes
        SET archived_at = now(), archived_by = $2, updated_at = now(), updated_by = $2
        WHERE id = $1::uuid AND archived_at IS NULL
      `,
      [params.id, params.audit.user_id]
    );

    await insertAuditLog(client, params.audit, {
      action: "production.postes.archive",
      entity_type: "postes",
      entity_id: params.id,
    });

    await client.query("COMMIT");
    return (upd.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// -------------------------
// OF (Ordres de fabrication)
// -------------------------

function ofSortColumn(sortBy: ListOfQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "o.created_at";
    case "numero":
      return "o.numero";
    case "date_lancement_prevue":
      return "o.date_lancement_prevue";
    case "date_fin_prevue":
      return "o.date_fin_prevue";
    case "statut":
      return "o.statut";
    case "priority":
      return "o.priority";
    case "updated_at":
    default:
      return "o.updated_at";
  }
}

async function selectOfHeader(
  q: DbQueryer,
  ofId: number
): Promise<Omit<OrdreFabricationDetail, "operations" | "allowed_statut_transitions"> | null> {
  type Row = {
    id: string;
    numero: string;
    affaire_id: string | null;
    commande_id: string | null;
    parent_of_id: string | null;
    root_of_id: string | null;
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
    statut: OrdreFabricationDetail["statut"];
    priority: OrdreFabricationDetail["priority"];
    date_lancement_prevue: string | null;
    date_fin_prevue: string | null;
    date_lancement_reelle: string | null;
    date_fin_reelle: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
    created_by: number | null;
    updated_by: number | null;
  };

  const res = await q.query<Row>(
    `
      SELECT
        o.id::text AS id,
        o.numero,
        o.affaire_id::text AS affaire_id,
        o.commande_id::text AS commande_id,
        o.parent_of_id::text AS parent_of_id,
        o.root_of_id::text AS root_of_id,
        o.generation_batch_id::text AS generation_batch_id,
        o.generation_level::int AS generation_level,
        o.source_bom_line_id::text AS source_bom_line_id,
        o.structure_path,
        o.quantity_per_parent::float8 AS quantity_per_parent,
        o.quantity_cumulative::float8 AS quantity_cumulative,
        o.client_id,
        c.company_name AS client_company_name,
        o.production_group_id::text AS production_group_id,
        pg.code AS production_group_code,
        o.piece_technique_id::text AS piece_technique_id,
        o.piece_technique_version_id::text AS piece_technique_version_id,
        o.technical_snapshot_sha256,
        o.technical_snapshot_at::text AS technical_snapshot_at,
        pt.code_piece AS piece_code,
        pt.designation AS piece_designation,
        o.quantite_lancee::float8 AS quantite_lancee,
        o.quantite_bonne::float8 AS quantite_bonne,
        o.quantite_rebut::float8 AS quantite_rebut,
        o.statut::text AS statut,
        o.priority::text AS priority,
        o.date_lancement_prevue::text AS date_lancement_prevue,
        o.date_fin_prevue::text AS date_fin_prevue,
        o.date_lancement_reelle::text AS date_lancement_reelle,
        o.date_fin_reelle::text AS date_fin_reelle,
        o.notes,
        o.created_at::text AS created_at,
        o.updated_at::text AS updated_at,
        o.created_by,
        o.updated_by
      FROM ordres_fabrication o
      JOIN pieces_techniques pt ON pt.id = o.piece_technique_id
      LEFT JOIN clients c ON c.client_id = o.client_id
      LEFT JOIN production_group pg ON pg.id = o.production_group_id
      WHERE o.id = $1::bigint
      LIMIT 1
    `,
    [ofId]
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    id: toInt(row.id, "ordres_fabrication.id"),
    numero: row.numero,
    affaire_id: toNullableInt(row.affaire_id, "ordres_fabrication.affaire_id"),
    commande_id: toNullableInt(row.commande_id, "ordres_fabrication.commande_id"),
    parent_of_id: toNullableInt(row.parent_of_id, "ordres_fabrication.parent_of_id"),
    root_of_id: toNullableInt(row.root_of_id, "ordres_fabrication.root_of_id"),
    generation_batch_id: row.generation_batch_id,
    generation_level: Number(row.generation_level),
    source_bom_line_id: row.source_bom_line_id,
    structure_path: row.structure_path,
    quantity_per_parent: Number(row.quantity_per_parent),
    quantity_cumulative: Number(row.quantity_cumulative),
    client_id: row.client_id,
    client_company_name: row.client_company_name,
    production_group_id: row.production_group_id,
    production_group_code: row.production_group_code,
    piece_technique_id: row.piece_technique_id,
    piece_technique_version_id: row.piece_technique_version_id,
    technical_snapshot_sha256: row.technical_snapshot_sha256,
    technical_snapshot_at: row.technical_snapshot_at,
    piece_code: row.piece_code,
    piece_designation: row.piece_designation,
    quantite_lancee: Number(row.quantite_lancee),
    quantite_bonne: Number(row.quantite_bonne),
    quantite_rebut: Number(row.quantite_rebut),
    statut: row.statut,
    priority: row.priority,
    date_lancement_prevue: row.date_lancement_prevue,
    date_fin_prevue: row.date_fin_prevue,
    date_lancement_reelle: row.date_lancement_reelle,
    date_fin_reelle: row.date_fin_reelle,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

function mapOpenTimeLog(row: {
  open_log_id: string | null;
  open_log_of_operation_id: string | null;
  open_log_user_id: number | null;
  open_log_machine_id: string | null;
  open_log_started_at: string | null;
  open_log_ended_at: string | null;
  open_log_duration_minutes: number | null;
  open_log_type: OfTimeLog["type"] | null;
  open_log_comment: string | null;
  open_log_created_at: string | null;
}): OfTimeLog | null {
  if (!row.open_log_id) return null;
  if (!row.open_log_of_operation_id) return null;
  if (typeof row.open_log_user_id !== "number") return null;
  if (!row.open_log_started_at) return null;
  if (!row.open_log_created_at) return null;
  if (!row.open_log_type) return null;

  return {
    id: row.open_log_id,
    of_operation_id: row.open_log_of_operation_id,
    user_id: row.open_log_user_id,
    machine_id: row.open_log_machine_id,
    started_at: row.open_log_started_at,
    ended_at: row.open_log_ended_at,
    duration_minutes: row.open_log_duration_minutes,
    type: row.open_log_type,
    comment: row.open_log_comment,
    created_at: row.open_log_created_at,
  };
}

async function selectOfOperation(q: DbQueryer, params: {
  of_id: number;
  op_id: string;
  user_id?: number;
}): Promise<OfOperation | null> {
  type Row = {
    id: string;
    of_id: string;
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
    status: OfOperation["status"];
    started_at: string | null;
    ended_at: string | null;
    notes: string | null;
    updated_at: string;
    open_log_id: string | null;
    open_log_of_operation_id: string | null;
    open_log_user_id: number | null;
    open_log_machine_id: string | null;
    open_log_started_at: string | null;
    open_log_ended_at: string | null;
    open_log_duration_minutes: number | null;
    open_log_type: OfTimeLog["type"] | null;
    open_log_comment: string | null;
    open_log_created_at: string | null;
  };

  const userId = typeof params.user_id === "number" ? params.user_id : null;

  const res = await q.query<Row>(
    `
      SELECT
        op.id::text AS id,
        op.of_id::text AS of_id,
        op.phase::int AS phase,
        op.designation,
        op.cf_id::text AS cf_id,
        op.poste_id::text AS poste_id,
        p.code AS poste_code,
        p.label AS poste_label,
        op.machine_id::text AS machine_id,
        m.code AS machine_code,
        m.name AS machine_name,
        op.hourly_rate_applied::float8 AS hourly_rate_applied,
        op.tp::float8 AS tp,
        op.tf_unit::float8 AS tf_unit,
        op.qte::float8 AS qte,
        op.coef::float8 AS coef,
        op.temps_total_planned::float8 AS temps_total_planned,
        op.temps_total_real::float8 AS temps_total_real,
        op.status::text AS status,
        op.started_at::text AS started_at,
        op.ended_at::text AS ended_at,
        op.notes,
        op.updated_at::text AS updated_at,
        open_log.id::text AS open_log_id,
        open_log.of_operation_id::text AS open_log_of_operation_id,
        open_log.user_id AS open_log_user_id,
        open_log.machine_id::text AS open_log_machine_id,
        open_log.started_at::text AS open_log_started_at,
        open_log.ended_at::text AS open_log_ended_at,
        open_log.duration_minutes::int AS open_log_duration_minutes,
        open_log.type::text AS open_log_type,
        open_log.comment AS open_log_comment,
        open_log.created_at::text AS open_log_created_at
      FROM of_operations op
      LEFT JOIN postes p ON p.id = op.poste_id
      LEFT JOIN machines m ON m.id = op.machine_id
      LEFT JOIN LATERAL (
        SELECT
          t.id,
          t.of_operation_id,
          t.user_id,
          t.machine_id,
          t.started_at,
          t.ended_at,
          t.duration_minutes,
          t.type,
          t.comment,
          t.created_at
        FROM of_time_logs t
        WHERE t.of_operation_id = op.id AND t.user_id = $3 AND t.ended_at IS NULL
        ORDER BY t.started_at DESC, t.id DESC
        LIMIT 1
      ) open_log ON TRUE
      WHERE op.of_id = $1::bigint AND op.id = $2::uuid
      LIMIT 1
    `,
    [params.of_id, params.op_id, userId]
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    of_id: toInt(row.of_id, "of_operations.of_id"),
    phase: row.phase,
    designation: row.designation,
    cf_id: row.cf_id,
    poste_id: row.poste_id,
    poste_code: row.poste_code,
    poste_label: row.poste_label,
    machine_id: row.machine_id,
    machine_code: row.machine_code,
    machine_name: row.machine_name,
    hourly_rate_applied: Number(row.hourly_rate_applied),
    tp: Number(row.tp),
    tf_unit: Number(row.tf_unit),
    qte: Number(row.qte),
    coef: Number(row.coef),
    temps_total_planned: Number(row.temps_total_planned),
    temps_total_real: Number(row.temps_total_real),
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    notes: row.notes,
    updated_at: row.updated_at,
    open_time_log: mapOpenTimeLog(row),
  };
}

async function selectOfOperations(q: DbQueryer, params: { of_id: number; user_id?: number }): Promise<OfOperation[]> {
  type Row = {
    id: string;
    of_id: string;
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
    status: OfOperation["status"];
    started_at: string | null;
    ended_at: string | null;
    notes: string | null;
    updated_at: string;
    open_log_id: string | null;
    open_log_of_operation_id: string | null;
    open_log_user_id: number | null;
    open_log_machine_id: string | null;
    open_log_started_at: string | null;
    open_log_ended_at: string | null;
    open_log_duration_minutes: number | null;
    open_log_type: OfTimeLog["type"] | null;
    open_log_comment: string | null;
    open_log_created_at: string | null;
  };

  const userId = typeof params.user_id === "number" ? params.user_id : null;

  const res = await q.query<Row>(
    `
      SELECT
        op.id::text AS id,
        op.of_id::text AS of_id,
        op.phase::int AS phase,
        op.designation,
        op.cf_id::text AS cf_id,
        op.poste_id::text AS poste_id,
        p.code AS poste_code,
        p.label AS poste_label,
        op.machine_id::text AS machine_id,
        m.code AS machine_code,
        m.name AS machine_name,
        op.hourly_rate_applied::float8 AS hourly_rate_applied,
        op.tp::float8 AS tp,
        op.tf_unit::float8 AS tf_unit,
        op.qte::float8 AS qte,
        op.coef::float8 AS coef,
        op.temps_total_planned::float8 AS temps_total_planned,
        op.temps_total_real::float8 AS temps_total_real,
        op.status::text AS status,
        op.started_at::text AS started_at,
        op.ended_at::text AS ended_at,
        op.notes,
        op.updated_at::text AS updated_at,
        open_log.id::text AS open_log_id,
        open_log.of_operation_id::text AS open_log_of_operation_id,
        open_log.user_id AS open_log_user_id,
        open_log.machine_id::text AS open_log_machine_id,
        open_log.started_at::text AS open_log_started_at,
        open_log.ended_at::text AS open_log_ended_at,
        open_log.duration_minutes::int AS open_log_duration_minutes,
        open_log.type::text AS open_log_type,
        open_log.comment AS open_log_comment,
        open_log.created_at::text AS open_log_created_at
      FROM of_operations op
      LEFT JOIN postes p ON p.id = op.poste_id
      LEFT JOIN machines m ON m.id = op.machine_id
      LEFT JOIN LATERAL (
        SELECT
          t.id,
          t.of_operation_id,
          t.user_id,
          t.machine_id,
          t.started_at,
          t.ended_at,
          t.duration_minutes,
          t.type,
          t.comment,
          t.created_at
        FROM of_time_logs t
        WHERE t.of_operation_id = op.id AND t.user_id = $2 AND t.ended_at IS NULL
        ORDER BY t.started_at DESC, t.id DESC
        LIMIT 1
      ) open_log ON TRUE
      WHERE op.of_id = $1::bigint
      ORDER BY op.phase ASC, op.id ASC
    `,
    [params.of_id, userId]
  );

  return res.rows.map((row) => ({
    id: row.id,
    of_id: toInt(row.of_id, "of_operations.of_id"),
    phase: row.phase,
    designation: row.designation,
    cf_id: row.cf_id,
    poste_id: row.poste_id,
    poste_code: row.poste_code,
    poste_label: row.poste_label,
    machine_id: row.machine_id,
    machine_code: row.machine_code,
    machine_name: row.machine_name,
    hourly_rate_applied: Number(row.hourly_rate_applied),
    tp: Number(row.tp),
    tf_unit: Number(row.tf_unit),
    qte: Number(row.qte),
    coef: Number(row.coef),
    temps_total_planned: Number(row.temps_total_planned),
    temps_total_real: Number(row.temps_total_real),
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    notes: row.notes,
    updated_at: row.updated_at,
    open_time_log: mapOpenTimeLog(row),
  }));
}

export async function repoListOrdresFabrication(filters: ListOfQueryDTO): Promise<Paginated<OrdreFabricationListItem>> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const q = `%${filters.q.trim()}%`;
    const p = push(q);
    where.push(`(
      o.numero ILIKE ${p}
      OR pt.code_piece ILIKE ${p}
      OR pt.designation ILIKE ${p}
      OR COALESCE(c.company_name,'') ILIKE ${p}
    )`);
  }

  if (filters.client_id) where.push(`o.client_id = ${push(filters.client_id)}`);
  if (typeof filters.affaire_id === "number") where.push(`o.affaire_id = ${push(filters.affaire_id)}::bigint`);
  if (typeof filters.commande_id === "number") where.push(`o.commande_id = ${push(filters.commande_id)}::bigint`);
  if (filters.piece_technique_id) where.push(`o.piece_technique_id = ${push(filters.piece_technique_id)}::uuid`);
  if (filters.statut) where.push(`o.statut = ${push(filters.statut)}::of_status`);
  if (filters.priority) where.push(`o.priority = ${push(filters.priority)}::of_priority`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const countRes = await pool.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM ordres_fabrication o
      JOIN pieces_techniques pt ON pt.id = o.piece_technique_id
      LEFT JOIN clients c ON c.client_id = o.client_id
      ${whereSql}
    `,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const orderBy = ofSortColumn(filters.sortBy);
  const orderDir = sortDir(filters.sortDir);

  type Row = {
    id: string;
    numero: string;
    affaire_id: string | null;
    commande_id: string | null;
    parent_of_id: string | null;
    root_of_id: string | null;
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
    statut: OrdreFabricationListItem["statut"];
    priority: OrdreFabricationListItem["priority"];
    date_lancement_prevue: string | null;
    date_fin_prevue: string | null;
    updated_at: string;
    total_ops: number;
    done_ops: number;
  };

  const dataRes = await pool.query<Row>(
    `
      SELECT
        o.id::text AS id,
        o.numero,
        o.affaire_id::text AS affaire_id,
        o.commande_id::text AS commande_id,
        o.parent_of_id::text AS parent_of_id,
        o.root_of_id::text AS root_of_id,
        o.generation_batch_id::text AS generation_batch_id,
        o.generation_level::int AS generation_level,
        o.source_bom_line_id::text AS source_bom_line_id,
        o.structure_path,
        o.quantity_per_parent::float8 AS quantity_per_parent,
        o.quantity_cumulative::float8 AS quantity_cumulative,
        o.client_id,
        c.company_name AS client_company_name,
        o.production_group_id::text AS production_group_id,
        pg.code AS production_group_code,
        o.piece_technique_id::text AS piece_technique_id,
        pt.code_piece AS piece_code,
        pt.designation AS piece_designation,
        o.quantite_lancee::float8 AS quantite_lancee,
        o.quantite_bonne::float8 AS quantite_bonne,
        o.quantite_rebut::float8 AS quantite_rebut,
        o.statut::text AS statut,
        o.priority::text AS priority,
        o.date_lancement_prevue::text AS date_lancement_prevue,
        o.date_fin_prevue::text AS date_fin_prevue,
        o.updated_at::text AS updated_at,
        COALESCE(ops.total_ops, 0)::int AS total_ops,
        COALESCE(ops.done_ops, 0)::int AS done_ops
      FROM ordres_fabrication o
      JOIN pieces_techniques pt ON pt.id = o.piece_technique_id
      LEFT JOIN clients c ON c.client_id = o.client_id
      LEFT JOIN production_group pg ON pg.id = o.production_group_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS total_ops,
          COUNT(*) FILTER (WHERE op.status = 'DONE') AS done_ops
        FROM of_operations op
        WHERE op.of_id = o.id
      ) ops ON TRUE
      ${whereSql}
      ORDER BY ${orderBy} ${orderDir}, o.id ${orderDir}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  );

  const items = dataRes.rows.map((r) => ({
    id: toInt(r.id, "ordres_fabrication.id"),
    numero: r.numero,
    affaire_id: toNullableInt(r.affaire_id, "ordres_fabrication.affaire_id"),
    commande_id: toNullableInt(r.commande_id, "ordres_fabrication.commande_id"),
    parent_of_id: toNullableInt(r.parent_of_id, "ordres_fabrication.parent_of_id"),
    root_of_id: toNullableInt(r.root_of_id, "ordres_fabrication.root_of_id"),
    generation_batch_id: r.generation_batch_id,
    generation_level: Number(r.generation_level),
    source_bom_line_id: r.source_bom_line_id,
    structure_path: r.structure_path,
    quantity_per_parent: Number(r.quantity_per_parent),
    quantity_cumulative: Number(r.quantity_cumulative),
    client_id: r.client_id,
    client_company_name: r.client_company_name,
    production_group_id: r.production_group_id,
    production_group_code: r.production_group_code,
    piece_technique_id: r.piece_technique_id,
    piece_code: r.piece_code,
    piece_designation: r.piece_designation,
    quantite_lancee: Number(r.quantite_lancee),
    quantite_bonne: Number(r.quantite_bonne),
    quantite_rebut: Number(r.quantite_rebut),
    statut: r.statut,
    priority: r.priority,
    date_lancement_prevue: r.date_lancement_prevue,
    date_fin_prevue: r.date_fin_prevue,
    updated_at: r.updated_at,
    total_ops: Number(r.total_ops),
    done_ops: Number(r.done_ops),
  }));

  return { items, total };
}

export async function repoGetOrdreFabrication(params: {
  id: number;
  user_id?: number;
}): Promise<OrdreFabricationDetail | null> {
  const header = await selectOfHeader(pool, params.id);
  if (!header) return null;

  const operations = await selectOfOperations(pool, { of_id: params.id, user_id: params.user_id });

  // #170 : la fiche expose les transitions licites — l'UI n'invente jamais un statut.
  const statut = header.statut as OfStatut;
  const allowed = OF_STATUT_TRANSITIONS[statut] ?? [];

  return { ...header, operations, allowed_statut_transitions: [...allowed] };
}

type OfTreeRow = {
  key: string;
  parent_key: string | null;
  id: string;
  numero: string;
  affaire_id: string | null;
  commande_id: string | null;
  parent_of_id: string | null;
  root_of_id: string | null;
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
  statut: OrdreFabricationListItem["statut"];
  priority: OrdreFabricationListItem["priority"];
  date_lancement_prevue: string | null;
  date_fin_prevue: string | null;
  updated_at: string;
  total_ops: number;
  done_ops: number;
};

function mapOfTreeRow(row: OfTreeRow): OrdreFabricationTreeNode {
  return {
    id: toInt(row.id, "ordres_fabrication.id"),
    numero: row.numero,
    affaire_id: toNullableInt(row.affaire_id, "ordres_fabrication.affaire_id"),
    commande_id: toNullableInt(row.commande_id, "ordres_fabrication.commande_id"),
    parent_of_id: toNullableInt(row.parent_of_id, "ordres_fabrication.parent_of_id"),
    root_of_id: toNullableInt(row.root_of_id, "ordres_fabrication.root_of_id"),
    generation_batch_id: row.generation_batch_id,
    generation_level: Number(row.generation_level),
    source_bom_line_id: row.source_bom_line_id,
    structure_path: row.structure_path,
    quantity_per_parent: Number(row.quantity_per_parent),
    quantity_cumulative: Number(row.quantity_cumulative),
    client_id: row.client_id,
    client_company_name: row.client_company_name,
    production_group_id: row.production_group_id,
    production_group_code: row.production_group_code,
    piece_technique_id: row.piece_technique_id,
    piece_code: row.piece_code,
    piece_designation: row.piece_designation,
    quantite_lancee: Number(row.quantite_lancee),
    quantite_bonne: Number(row.quantite_bonne),
    quantite_rebut: Number(row.quantite_rebut),
    statut: row.statut,
    priority: row.priority,
    date_lancement_prevue: row.date_lancement_prevue,
    date_fin_prevue: row.date_fin_prevue,
    updated_at: row.updated_at,
    total_ops: Number(row.total_ops),
    done_ops: Number(row.done_ops),
    children: [],
  };
}

export async function repoGetOrdreFabricationTree(id: number): Promise<OrdreFabricationTree | null> {
  const res = await pool.query<OfTreeRow>(
    `
      WITH RECURSIVE root AS (
        SELECT COALESCE(root_of_id, id)::bigint AS root_id
        FROM ordres_fabrication
        WHERE id = $1::bigint
        LIMIT 1
      ),
      tree AS (
        SELECT
          o.*,
          ARRAY[o.id]::bigint[] AS path_ids,
          0::int AS depth
        FROM ordres_fabrication o
        JOIN root r ON r.root_id = o.id

        UNION ALL

        SELECT
          child.*,
          tree.path_ids || child.id,
          tree.depth + 1
        FROM tree
        JOIN ordres_fabrication child ON child.parent_of_id = tree.id
        WHERE tree.depth < 50
          AND NOT child.id = ANY(tree.path_ids)
      ),
      enriched AS (
        SELECT
          array_to_string(path_ids::text[], '/') AS key,
          CASE
            WHEN array_length(path_ids, 1) > 1
              THEN array_to_string(path_ids[1:(array_length(path_ids, 1) - 1)]::text[], '/')
            ELSE NULL
          END AS parent_key,
          t.*
        FROM tree t
      )
      SELECT
        e.key,
        e.parent_key,
        e.id::text AS id,
        e.numero,
        e.affaire_id::text AS affaire_id,
        e.commande_id::text AS commande_id,
        e.parent_of_id::text AS parent_of_id,
        e.root_of_id::text AS root_of_id,
        e.generation_batch_id::text AS generation_batch_id,
        e.generation_level::int AS generation_level,
        e.source_bom_line_id::text AS source_bom_line_id,
        e.structure_path,
        e.quantity_per_parent::float8 AS quantity_per_parent,
        e.quantity_cumulative::float8 AS quantity_cumulative,
        e.client_id,
        c.company_name AS client_company_name,
        e.production_group_id::text AS production_group_id,
        pg.code AS production_group_code,
        e.piece_technique_id::text AS piece_technique_id,
        pt.code_piece AS piece_code,
        pt.designation AS piece_designation,
        e.quantite_lancee::float8 AS quantite_lancee,
        e.quantite_bonne::float8 AS quantite_bonne,
        e.quantite_rebut::float8 AS quantite_rebut,
        e.statut::text AS statut,
        e.priority::text AS priority,
        e.date_lancement_prevue::text AS date_lancement_prevue,
        e.date_fin_prevue::text AS date_fin_prevue,
        e.updated_at::text AS updated_at,
        COALESCE(ops.total_ops, 0)::int AS total_ops,
        COALESCE(ops.done_ops, 0)::int AS done_ops
      FROM enriched e
      JOIN pieces_techniques pt ON pt.id = e.piece_technique_id
      LEFT JOIN clients c ON c.client_id = e.client_id
      LEFT JOIN production_group pg ON pg.id = e.production_group_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS total_ops,
          COUNT(*) FILTER (WHERE op.status = 'DONE') AS done_ops
        FROM of_operations op
        WHERE op.of_id = e.id
      ) ops ON TRUE
      ORDER BY e.path_ids ASC
    `,
    [id]
  );

  if (!res.rows.length) return null;

  const nodes = res.rows.map(mapOfTreeRow);
  const byKey = new Map(nodes.map((node, index) => [res.rows[index].key, node] as const));
  let root: OrdreFabricationTreeNode | null = null;

  for (const row of res.rows) {
    const node = byKey.get(row.key);
    if (!node) continue;
    if (!row.parent_key) {
      root = node;
      continue;
    }
    byKey.get(row.parent_key)?.children.push(node);
  }

  if (!root) return null;

  return {
    root,
    nodes,
    total_nodes: nodes.length,
    max_depth: nodes.reduce((max, node) => Math.max(max, node.generation_level), 0),
  };
}

export async function repoCreateOrdreFabrication(params: {
  body: CreateOfBodyDTO;
  audit: AuditContext;
}): Promise<OrdreFabricationDetail> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const pt = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM pieces_techniques WHERE id = $1::uuid LIMIT 1`,
      [params.body.piece_technique_id]
    );
    if (!pt.rows[0]?.id) {
      throw new HttpError(422, "PIECE_TECHNIQUE_NOT_FOUND", "Piece technique not found");
    }

    // #170 : sélection/validation de version et snapshot unifiés avec le moteur
    // de génération récursive (aucun chemin ne contourne la même porte).
    const technical = await loadApplicableTechnicalSnapshot(client, params.body.piece_technique_id, {
      pinned_version_id: params.body.piece_technique_version_id,
    });
    const technicalSnapshot = technical.snapshot;
    const technicalSnapshotSha256 = technical.sha256;

    const idRes = await client.query<{ of_id: string }>(
      `SELECT nextval(pg_get_serial_sequence('public.ordres_fabrication','id'))::text AS of_id`
    );
    const rawId = idRes.rows[0]?.of_id;
    const ofId = toInt(rawId, "ordres_fabrication.id");

    const b = params.body;
    const numeroForInsert = await generateTransactionalBusinessCode(client, { prefix: "OF" });

    const ins = await client.query<{ id: string; numero: string }>(
      `
        INSERT INTO ordres_fabrication (
          id,
          numero,
          affaire_id,
          commande_id,
          parent_of_id,
          root_of_id,
          generation_level,
          structure_path,
          quantity_per_parent,
          quantity_cumulative,
          client_id,
          piece_technique_id,
          piece_technique_version_id,
          technical_snapshot,
          technical_snapshot_sha256,
          technical_snapshot_at,
          quantite_lancee,
          statut,
          priority,
          date_lancement_prevue,
          date_fin_prevue,
          notes,
          created_by,
          updated_by
        )
        VALUES (
          $1,
          $2,
          $3::bigint,
          $4::bigint,
          NULL::bigint,
          $1::bigint,
          0,
          $1::text,
          1,
          1,
          $5,
          $6::uuid,
          $7::uuid,
          $8::jsonb,
          $9,
          now(),
          $10,
          $11::of_status,
          $12::of_priority,
          $13::date,
          $14::date,
          $15,
          $16,
          $16
        )
        RETURNING id::text AS id, numero
      `,
      [
        ofId,
        numeroForInsert,
        b.affaire_id ?? null,
        b.commande_id ?? null,
        b.client_id ?? null,
        b.piece_technique_id,
        technical.version_id,
        JSON.stringify(technicalSnapshot),
        technicalSnapshotSha256,
        b.quantite_lancee,
        b.statut,
        b.priority,
        b.date_lancement_prevue ?? null,
        b.date_fin_prevue ?? null,
        b.notes ?? null,
        params.audit.user_id,
      ]
    );

    const created = ins.rows[0];
    if (!created) throw new Error("Failed to create OF");

    const operationsCount = await copyPieceOperationsToOf(client, {
      of_id: ofId,
      piece_technique_id: b.piece_technique_id,
      gamme_id: technical.gamme_id,
    });
    // #170 : même refus que la génération récursive — pas d'OF sans gamme/opérations.
    if (operationsCount === 0) {
      throw new HttpError(
        409,
        "PIECE_TECHNIQUE_OPERATION_REQUIRED",
        "Impossible de créer l'OF : la pièce technique n'a aucune opération de gamme applicable."
      );
    }

    await client.query(
      `INSERT INTO public.of_technical_snapshots (of_id, piece_technique_version_id, snapshot, snapshot_sha256, created_by)
       VALUES ($1::bigint, $2::uuid, $3::jsonb, $4, $5)`,
      [ofId, technical.version_id, JSON.stringify(technicalSnapshot), technicalSnapshotSha256, params.audit.user_id]
    );

    await insertAuditLog(client, params.audit, {
      action: "production.of.create",
      entity_type: "ordres_fabrication",
      entity_id: String(ofId),
      details: {
        numero: created.numero,
        piece_technique_id: b.piece_technique_id,
        piece_technique_version_id: technical.version_id,
        technical_snapshot_sha256: technicalSnapshotSha256,
        quantite_lancee: b.quantite_lancee,
        operations_count: operationsCount,
      },
    });

    await client.query("COMMIT");

    const out = await repoGetOrdreFabrication({ id: ofId, user_id: params.audit.user_id });
    if (!out) throw new Error("Failed to load created OF");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "OF_NUMERO_EXISTS", "An OF with this number already exists");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateOrdreFabrication(params: {
  id: number;
  patch: UpdateOfBodyDTO;
  audit: AuditContext;
}): Promise<OrdreFabricationDetail | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{
      id: string;
      commande_id: string | null;
      statut: string;
      updated_at: string | null;
    }>(
      `
        SELECT
          id::text AS id,
          commande_id::text AS commande_id,
          statut::text AS statut,
          updated_at::text AS updated_at
        FROM ordres_fabrication
        WHERE id = $1::bigint
        FOR UPDATE
      `,
      [params.id]
    );
    const ofRow = exists.rows[0] ?? null;
    if (!ofRow?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    // #170 : verrou optimiste — même mécanique que affaire/devis/machines.
    if (
      params.patch.expected_updated_at &&
      ofRow.updated_at &&
      params.patch.expected_updated_at !== ofRow.updated_at
    ) {
      throw new HttpError(
        409,
        "CONCURRENT_MODIFICATION",
        "L'OF a été modifié par une autre session. Rechargez la fiche avant de réessayer.",
        { expected_updated_at: params.patch.expected_updated_at, actual_updated_at: ofRow.updated_at }
      );
    }

    const currentStatut = ofRow.statut as OfStatut;
    const requestedStatut = (params.patch.statut ?? currentStatut) as OfStatut;
    const statutChanges = params.patch.statut !== undefined && requestedStatut !== currentStatut;

    // #170 : machine d'état serveur — aucune transition libre.
    if (statutChanges && !canTransitionOfStatut(currentStatut, requestedStatut)) {
      throw new HttpError(
        409,
        "OF_INVALID_TRANSITION",
        `Transition ${currentStatut} → ${requestedStatut} refusée par l'automate OF.`,
        { from: currentStatut, to: requestedStatut, allowed: OF_STATUT_TRANSITIONS[currentStatut] }
      );
    }
    if (statutChanges && params.audit.user_role !== undefined) {
      const capability = capabilityForOfTransition(currentStatut, requestedStatut);
      if (!roleHasOfCapability(params.audit.user_role, capability)) {
        throw new HttpError(403, "OF_TRANSITION_FORBIDDEN", "Votre rôle ne permet pas cette transition d'OF.", {
          capability,
        });
      }
    }

    // #170 : un OF lancé n'est plus librement éditable — seule la vie d'atelier
    // reste ouverte (statut, quantités réalisées, dates réelles, priorité, notes).
    const lifeFields = new Set<keyof UpdateOfBodyDTO>([
      "statut",
      "quantite_bonne",
      "quantite_rebut",
      "date_lancement_reelle",
      "date_fin_reelle",
      "priority",
      "notes",
      "expected_updated_at",
    ]);
    const patchKeys = Object.keys(params.patch) as Array<keyof UpdateOfBodyDTO>;
    const hasStructuralChange = patchKeys.some((k) => !lifeFields.has(k));
    if (hasStructuralChange && !isOfPrelaunch(currentStatut)) {
      throw new HttpError(
        409,
        "OF_LOCKED_AFTER_LAUNCH",
        "L'OF est lancé : ses données structurantes (quantité lancée, rattachements, dates prévues) sont verrouillées.",
        { statut: currentStatut }
      );
    }
    if (hasStructuralChange && params.audit.user_role !== undefined && !roleHasOfCapability(params.audit.user_role, "edit_prelaunch")) {
      throw new HttpError(403, "OF_EDIT_FORBIDDEN", "Votre rôle ne permet pas de modifier la structure d'un OF.");
    }

    const commandeId = ofRow.commande_id ? toInt(ofRow.commande_id, "ordres_fabrication.commande_id") : null;
    if (commandeId !== null) {
      const lockRes = await client.query<{ ar_sent_at: string | null }>(
        `SELECT ar_sent_at::text AS ar_sent_at FROM commande_client WHERE id = $1::bigint LIMIT 1`,
        [commandeId]
      );
      const lockedAfterAr = Boolean(lockRes.rows[0]?.ar_sent_at);
      if (lockedAfterAr) {
        const allowed = new Set<keyof UpdateOfBodyDTO>([
          "statut",
          "quantite_bonne",
          "quantite_rebut",
          "date_lancement_reelle",
          "date_fin_reelle",
          "notes",
          "expected_updated_at",
        ]);
        const keys = Object.keys(params.patch) as Array<keyof UpdateOfBodyDTO>;
        const hasDisallowed = keys.some((k) => !allowed.has(k));
        if (hasDisallowed) {
          throw new HttpError(409, "OF_LOCKED_AFTER_AR", "OF is locked after AR has been sent");
        }
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    const p = params.patch;
    if (p.affaire_id !== undefined) sets.push(`affaire_id = ${push(p.affaire_id)}::bigint`);
    if (p.commande_id !== undefined) sets.push(`commande_id = ${push(p.commande_id)}::bigint`);
    if (p.client_id !== undefined) sets.push(`client_id = ${push(p.client_id ?? null)}`);
    if (p.quantite_lancee !== undefined) sets.push(`quantite_lancee = ${push(p.quantite_lancee)}`);
    if (p.quantite_bonne !== undefined) sets.push(`quantite_bonne = ${push(p.quantite_bonne)}`);
    if (p.quantite_rebut !== undefined) sets.push(`quantite_rebut = ${push(p.quantite_rebut)}`);
    if (p.statut !== undefined) sets.push(`statut = ${push(p.statut)}::of_status`);
    if (p.priority !== undefined) sets.push(`priority = ${push(p.priority)}::of_priority`);
    if (p.date_lancement_prevue !== undefined) sets.push(`date_lancement_prevue = ${push(p.date_lancement_prevue)}::date`);
    if (p.date_fin_prevue !== undefined) sets.push(`date_fin_prevue = ${push(p.date_fin_prevue)}::date`);
    if (p.date_lancement_reelle !== undefined) sets.push(`date_lancement_reelle = ${push(p.date_lancement_reelle)}::date`);
    if (p.date_fin_reelle !== undefined) sets.push(`date_fin_reelle = ${push(p.date_fin_reelle)}::date`);
    if (p.notes !== undefined) sets.push(`notes = ${push(p.notes ?? null)}`);

    if (p.statut === "EN_COURS" && p.date_lancement_reelle === undefined) {
      sets.push(`date_lancement_reelle = COALESCE(date_lancement_reelle, CURRENT_DATE)`);
    }
    if ((p.statut === "TERMINE" || p.statut === "CLOTURE") && p.date_fin_reelle === undefined) {
      sets.push(`date_fin_reelle = COALESCE(date_fin_reelle, CURRENT_DATE)`);
    }

    sets.push(`updated_by = ${push(params.audit.user_id)}`);
    sets.push(`updated_at = now()`);

    const upd = await client.query<{ id: string }>(
      `UPDATE ordres_fabrication SET ${sets.join(", ")} WHERE id = ${push(params.id)}::bigint RETURNING id::text AS id`,
      values
    );
    if (!upd.rows[0]?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    await insertAuditLog(client, params.audit, {
      action: "production.of.update",
      entity_type: "ordres_fabrication",
      entity_id: String(params.id),
      details: {
        patch: params.patch,
      },
    });

    await client.query("COMMIT");

    return repoGetOrdreFabrication({ id: params.id, user_id: params.audit.user_id });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateOrdreFabricationOperation(params: {
  of_id: number;
  op_id: string;
  patch: UpdateOfOperationBodyDTO;
  audit: AuditContext;
}): Promise<OfOperation | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await client.query<{ id: string; status: OfOperation["status"] }>(
      `
        SELECT id::text AS id, status::text AS status
        FROM of_operations
        WHERE of_id = $1::bigint AND id = $2::uuid
        FOR UPDATE
      `,
      [params.of_id, params.op_id]
    );
    const existing = before.rows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    const p = params.patch;

    const wantsResourceChange = p.poste_id !== undefined || p.machine_id !== undefined;
    if (wantsResourceChange) {
      const ofRes = await client.query<{ commande_id: string | null }>(
        `SELECT commande_id::text AS commande_id FROM ordres_fabrication WHERE id = $1::bigint LIMIT 1`,
        [params.of_id]
      );
      const commandeId = ofRes.rows[0]?.commande_id ? toInt(ofRes.rows[0].commande_id, "ordres_fabrication.commande_id") : null;
      if (commandeId !== null) {
        const lockRes = await client.query<{ ar_sent_at: string | null }>(
          `SELECT ar_sent_at::text AS ar_sent_at FROM commande_client WHERE id = $1::bigint LIMIT 1`,
          [commandeId]
        );
        const lockedAfterAr = Boolean(lockRes.rows[0]?.ar_sent_at);
        if (lockedAfterAr) {
          throw new HttpError(409, "OF_OPERATION_LOCKED_AFTER_AR", "OF operation is locked after AR has been sent");
        }
      }
    }

    if (p.poste_id !== undefined) sets.push(`poste_id = ${push(p.poste_id ?? null)}::uuid`);
    if (p.machine_id !== undefined) sets.push(`machine_id = ${push(p.machine_id ?? null)}::uuid`);
    if (p.status !== undefined) {
      // #170 : transitions d'opération contrôlées par l'automate serveur.
      const fromStatus = existing.status as OfOperationStatus;
      const toStatus = p.status as OfOperationStatus;
      if (!canTransitionOfOperationStatus(fromStatus, toStatus)) {
        throw new HttpError(
          409,
          "OF_OPERATION_INVALID_TRANSITION",
          `Transition ${fromStatus} → ${toStatus} refusée par l'automate d'opération.`,
          { from: fromStatus, to: toStatus }
        );
      }
      sets.push(`status = ${push(p.status)}::of_operation_status`);
      if (p.status === "RUNNING") sets.push(`started_at = COALESCE(started_at, now())`);
      if (p.status === "DONE") sets.push(`ended_at = COALESCE(ended_at, now())`);
    }
    if (p.notes !== undefined) sets.push(`notes = ${push(p.notes ?? null)}`);
    sets.push(`updated_at = now()`);

    const upd = await client.query<{ id: string }>(
      `
        UPDATE of_operations
        SET ${sets.join(", ")}
        WHERE of_id = ${push(params.of_id)}::bigint AND id = ${push(params.op_id)}::uuid
        RETURNING id::text AS id
      `,
      values
    );
    if (!upd.rows[0]?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `UPDATE ordres_fabrication SET updated_at = now(), updated_by = $2 WHERE id = $1::bigint`,
      [params.of_id, params.audit.user_id]
    );

    await insertAuditLog(client, params.audit, {
      action: "production.of.operation.update",
      entity_type: "of_operations",
      entity_id: params.op_id,
      details: {
        of_id: params.of_id,
        previous_status: existing.status,
        next_status: p.status ?? existing.status,
        poste_id: p.poste_id,
        machine_id: p.machine_id,
      },
    });

    await client.query("COMMIT");

    return selectOfOperation(pool, { of_id: params.of_id, op_id: params.op_id, user_id: params.audit.user_id });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoStartOfOperationTimeLog(params: {
  of_id: number;
  op_id: string;
  body: StartOfTimeLogBodyDTO;
  audit: AuditContext;
}): Promise<OfOperation | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // #170 : le pointage verrouille aussi l'OF — la règle d'admissibilité se
    // joue sur son statut, et le démarrage fait basculer un OF encore
    // BROUILLON/PLANIFIE en EN_COURS (transition serveur auditée).
    const ofRes = await client.query<{ id: string; statut: string }>(
      `
        SELECT id::text AS id, statut::text AS statut
        FROM ordres_fabrication
        WHERE id = $1::bigint
        FOR UPDATE
      `,
      [params.of_id]
    );
    const ofRow = ofRes.rows[0] ?? null;
    if (!ofRow?.id) {
      await client.query("ROLLBACK");
      return null;
    }
    const ofStatut = ofRow.statut as OfStatut;
    if (!ofStatutAllowsExecution(ofStatut)) {
      throw new HttpError(
        409,
        "OF_EXECUTION_NOT_ALLOWED",
        `Impossible de pointer sur un OF au statut ${ofStatut}.`,
        { statut: ofStatut }
      );
    }

    const op = await client.query<{ id: string; machine_id: string | null; status: string }>(
      `
        SELECT id::text AS id, machine_id::text AS machine_id, status::text AS status
        FROM of_operations
        WHERE of_id = $1::bigint AND id = $2::uuid
        FOR UPDATE
      `,
      [params.of_id, params.op_id]
    );
    const existing = op.rows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }
    if (existing.status === "DONE") {
      throw new HttpError(
        409,
        "OF_OPERATION_ALREADY_DONE",
        "Cette opération est déclarée terminée : rouvrez-la avant de pointer.",
        { op_id: params.op_id }
      );
    }
    if (existing.status === "BLOCKED") {
      throw new HttpError(
        409,
        "OF_OPERATION_BLOCKED",
        "Cette opération est suspendue : débloquez-la avant de pointer.",
        { op_id: params.op_id }
      );
    }

    const bodyMachineId = params.body.machine_id ?? null;
    const machineId = bodyMachineId ?? existing.machine_id;

    type LogRow = { id: string };
    const ins = await client.query<LogRow>(
      `
        INSERT INTO of_time_logs (
          of_operation_id,
          user_id,
          machine_id,
          started_at,
          type,
          comment
        )
        VALUES ($1::uuid, $2::int, $3::uuid, now(), $4::of_time_log_type, $5)
        RETURNING id::text AS id
      `,
      [params.op_id, params.audit.user_id, machineId, params.body.type, params.body.comment ?? null]
    );
    const logId = ins.rows[0]?.id ?? null;

    await client.query(
      `
        UPDATE of_operations
        SET
          status = 'RUNNING'::of_operation_status,
          started_at = COALESCE(started_at, now()),
          updated_at = now()
        WHERE of_id = $1::bigint AND id = $2::uuid
      `,
      [params.of_id, params.op_id]
    );

    const autoStarted = ofStatut === "BROUILLON" || ofStatut === "PLANIFIE" || ofStatut === "EN_PAUSE";
    await client.query(
      `
        UPDATE ordres_fabrication
        SET
          statut = CASE WHEN statut IN ('BROUILLON','PLANIFIE','EN_PAUSE') THEN 'EN_COURS'::of_status ELSE statut END,
          date_lancement_reelle = CASE WHEN statut IN ('BROUILLON','PLANIFIE') THEN COALESCE(date_lancement_reelle, CURRENT_DATE) ELSE date_lancement_reelle END,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::bigint
      `,
      [params.of_id, params.audit.user_id]
    );

    await insertAuditLog(client, params.audit, {
      action: "production.of.time-log.start",
      entity_type: "of_time_logs",
      entity_id: logId,
      details: {
        of_id: params.of_id,
        op_id: params.op_id,
        machine_id: machineId,
        type: params.body.type,
        of_statut_before: ofStatut,
        of_auto_started: autoStarted,
      },
    });

    await client.query("COMMIT");

    return selectOfOperation(pool, { of_id: params.of_id, op_id: params.op_id, user_id: params.audit.user_id });
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "OF_TIME_LOG_ALREADY_RUNNING", "A time log is already running for this operation");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoStopOfOperationTimeLog(params: {
  of_id: number;
  op_id: string;
  body: StopOfTimeLogBodyDTO;
  audit: AuditContext;
}): Promise<OfOperation | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const op = await client.query<{ id: string }>(
      `
        SELECT id::text AS id
        FROM of_operations
        WHERE of_id = $1::bigint AND id = $2::uuid
        FOR UPDATE
      `,
      [params.of_id, params.op_id]
    );
    if (!op.rows[0]?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    const open = await client.query<{ id: string }>(
      `
        SELECT id::text AS id
        FROM of_time_logs
        WHERE of_operation_id = $1::uuid
          AND user_id = $2::int
          AND ended_at IS NULL
        ORDER BY started_at DESC, id DESC
        LIMIT 1
        FOR UPDATE
      `,
      [params.op_id, params.audit.user_id]
    );
    const openId = open.rows[0]?.id ?? null;
    if (!openId) {
      throw new HttpError(409, "OF_NO_OPEN_TIME_LOG", "No running time log for this operation");
    }

    type StoppedRow = { id: string; duration_minutes: number | null };
    const stopped = await client.query<StoppedRow>(
      `
        UPDATE of_time_logs
        SET
          ended_at = now(),
          duration_minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)) / 60))::int,
          comment = COALESCE($3, comment)
        WHERE id = $1::uuid
          AND of_operation_id = $2::uuid
          AND ended_at IS NULL
        RETURNING id::text AS id, duration_minutes::int AS duration_minutes
      `,
      [openId, params.op_id, params.body.comment ?? null]
    );
    const durationMinutes = stopped.rows[0]?.duration_minutes ?? null;

    await client.query(
      `
        UPDATE of_operations op
        SET
          temps_total_real = ROUND(COALESCE((
            SELECT SUM(t.duration_minutes) / 60.0
            FROM of_time_logs t
            WHERE t.of_operation_id = op.id
              AND t.duration_minutes IS NOT NULL
          ), 0)::numeric, 3),
          updated_at = now()
        WHERE op.of_id = $1::bigint AND op.id = $2::uuid
      `,
      [params.of_id, params.op_id]
    );

    await client.query(
      `UPDATE ordres_fabrication SET updated_at = now(), updated_by = $2 WHERE id = $1::bigint`,
      [params.of_id, params.audit.user_id]
    );

    await insertAuditLog(client, params.audit, {
      action: "production.of.time-log.stop",
      entity_type: "of_time_logs",
      entity_id: openId,
      details: {
        of_id: params.of_id,
        op_id: params.op_id,
        duration_minutes: durationMinutes,
      },
    });

    await client.query("COMMIT");

    return selectOfOperation(pool, { of_id: params.of_id, op_id: params.op_id, user_id: params.audit.user_id });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * #170 — réordonnancement des opérations d'un OF avant lancement.
 * Licite uniquement quand l'OF est BROUILLON/PLANIFIE, qu'aucune opération n'a
 * démarré (TODO/READY) et que le jeton optimiste correspond. La séquence est
 * persistée dans `phase` (renumérotation transactionnelle en deux passes pour
 * respecter UNIQUE (of_id, phase)). Aucun réordonnancement sur un snapshot :
 * les snapshots restent la vérité historique, seule la vie de l'OF change.
 */
export async function repoReorderOfOperations(params: {
  of_id: number;
  body: ReorderOfOperationsBodyDTO;
  audit: AuditContext;
}): Promise<OrdreFabricationDetail | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ofRes = await client.query<{ id: string; statut: string; updated_at: string | null }>(
      `
        SELECT id::text AS id, statut::text AS statut, updated_at::text AS updated_at
        FROM ordres_fabrication
        WHERE id = $1::bigint
        FOR UPDATE
      `,
      [params.of_id]
    );
    const ofRow = ofRes.rows[0] ?? null;
    if (!ofRow?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    if (ofRow.updated_at && params.body.expected_updated_at !== ofRow.updated_at) {
      throw new HttpError(
        409,
        "CONCURRENT_MODIFICATION",
        "L'OF a été modifié par une autre session. Rechargez la fiche avant de réordonner.",
        { expected_updated_at: params.body.expected_updated_at, actual_updated_at: ofRow.updated_at }
      );
    }

    const statut = ofRow.statut as OfStatut;
    if (!isOfPrelaunch(statut)) {
      throw new HttpError(
        409,
        "OF_LOCKED_AFTER_LAUNCH",
        "La séquence d'opérations d'un OF lancé est verrouillée.",
        { statut }
      );
    }

    const opsRes = await client.query<{ id: string; phase: number; status: string }>(
      `
        SELECT id::text AS id, phase::int AS phase, status::text AS status
        FROM of_operations
        WHERE of_id = $1::bigint
        ORDER BY phase ASC, id ASC
        FOR UPDATE
      `,
      [params.of_id]
    );
    const existingOps = opsRes.rows;
    const existingIds = new Set(existingOps.map((op) => op.id));
    const requestedIds = new Set(params.body.operations.map((op) => op.op_id));
    if (existingIds.size !== requestedIds.size || [...existingIds].some((id) => !requestedIds.has(id))) {
      throw new HttpError(
        422,
        "OF_OPERATION_SET_MISMATCH",
        "La séquence proposée ne couvre pas exactement les opérations de l'OF.",
        { expected_count: existingIds.size, received_count: requestedIds.size }
      );
    }

    if (!ofOperationsAllowReorder(existingOps.map((op) => op.status))) {
      throw new HttpError(
        409,
        "OF_OPERATION_SEQUENCE_LOCKED",
        "Une opération a déjà démarré : la séquence ne peut plus être réordonnée.",
        { statuses: existingOps.map((op) => ({ id: op.id, status: op.status })) }
      );
    }

    // Passe 1 : décalage temporaire pour libérer les phases cibles (UNIQUE (of_id, phase)).
    await client.query(
      `UPDATE of_operations SET phase = phase + 1000000 WHERE of_id = $1::bigint`,
      [params.of_id]
    );
    // Passe 2 : phases finales.
    for (const op of params.body.operations) {
      await client.query(
        `UPDATE of_operations SET phase = $3::int, updated_at = now() WHERE of_id = $1::bigint AND id = $2::uuid`,
        [params.of_id, op.op_id, op.phase]
      );
    }

    await client.query(
      `UPDATE ordres_fabrication SET updated_at = now(), updated_by = $2 WHERE id = $1::bigint`,
      [params.of_id, params.audit.user_id]
    );

    await insertAuditLog(client, params.audit, {
      action: "production.of.operations.reorder",
      entity_type: "ordres_fabrication",
      entity_id: String(params.of_id),
      details: {
        previous: existingOps.map((op) => ({ id: op.id, phase: op.phase })),
        next: params.body.operations.map((op) => ({ id: op.op_id, phase: op.phase })),
      },
    });

    await client.query("COMMIT");

    return repoGetOrdreFabrication({ id: params.of_id, user_id: params.audit.user_id });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
