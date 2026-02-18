import type { PoolClient } from "pg";
import path from "node:path";

import pool from "../../../config/database";
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
  Paginated,
  PosteDetail,
  PosteListItem,
} from "../types/production.types";
import type {
  CreateMachineBodyDTO,
  CreateOfBodyDTO,
  CreatePosteBodyDTO,
  ListMachinesQueryDTO,
  ListOfQueryDTO,
  ListPostesQueryDTO,
  StartOfTimeLogBodyDTO,
  StopOfTimeLogBodyDTO,
  UpdateMachineBodyDTO,
  UpdateOfBodyDTO,
  UpdateOfOperationBodyDTO,
  UpdatePosteBodyDTO,
} from "../validators/production.validators";

export type AuditContext = {
  user_id: number;
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
    status: MachineListItem["status"];
    hourly_rate: number;
    currency: string;
    is_available: boolean;
    image_path: string | null;
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
        m.status::text AS status,
        m.hourly_rate::float8 AS hourly_rate,
        m.currency,
        m.is_available,
        m.image_path,
        m.archived_at::text AS archived_at,
        m.updated_at::text AS updated_at
      FROM machines m
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
    status: r.status,
    hourly_rate: Number(r.hourly_rate),
    currency: r.currency,
    is_available: r.is_available,
    image_url: imageUrl(r.image_path),
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
    brand: string | null;
    model: string | null;
    serial_number: string | null;
    image_path: string | null;
    hourly_rate: number;
    currency: string;
    is_available: boolean;
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
        m.brand,
        m.model,
        m.serial_number,
        m.image_path,
        m.hourly_rate::float8 AS hourly_rate,
        m.currency,
        m.is_available,
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
    status: row.status,
    hourly_rate: Number(row.hourly_rate),
    currency: row.currency,
    is_available: row.is_available,
    image_url: imageUrl(row.image_path),
    image_path: row.image_path,
    brand: row.brand,
    model: row.model,
    serial_number: row.serial_number,
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
      brand: string | null;
      model: string | null;
      serial_number: string | null;
      image_path: string | null;
      hourly_rate: number;
      currency: string;
      is_available: boolean;
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

    const ins = await client.query<Row>(
      `
        INSERT INTO machines (
          code,
          name,
          type,
          brand,
          model,
          serial_number,
          image_path,
          hourly_rate,
          currency,
          status,
          is_available,
          location,
          workshop_zone,
          notes,
          created_by,
          updated_by
        )
        VALUES (
          $1,$2,$3::machine_type,$4,$5,$6,$7,
          $8,$9,$10::machine_status,$11,$12,$13,$14,$15,$16
        )
        RETURNING
          id::text AS id,
          code,
          name,
          type::text AS type,
          status::text AS status,
          brand,
          model,
          serial_number,
          image_path,
          hourly_rate::float8 AS hourly_rate,
          currency,
          is_available,
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
        b.code,
        b.name,
        b.type,
        b.brand ?? null,
        b.model ?? null,
        b.serial_number ?? null,
        params.image_path,
        b.hourly_rate,
        b.currency,
        b.status,
        b.is_available,
        b.location ?? null,
        b.workshop_zone ?? null,
        b.notes ?? null,
        createdBy,
        updatedBy,
      ]
    );

    const row = ins.rows[0];
    if (!row) throw new Error("Failed to create machine");

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
      status: row.status,
      hourly_rate: Number(row.hourly_rate),
      currency: row.currency,
      is_available: row.is_available,
      image_url: imageUrl(row.image_path),
      image_path: row.image_path,
      archived_at: row.archived_at,
      updated_at: row.updated_at,
      brand: row.brand,
      model: row.model,
      serial_number: row.serial_number,
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

export async function repoUpdateMachine(params: {
  id: string;
  patch: UpdateMachineBodyDTO;
  image_path?: string | null;
  audit: AuditContext;
}): Promise<MachineDetail | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await client.query<{ id: string; archived_at: string | null }>(
      `SELECT id::text AS id, archived_at::text AS archived_at FROM machines WHERE id = $1::uuid FOR UPDATE`,
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

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    const p = params.patch;
    if (p.code !== undefined) sets.push(`code = ${push(p.code)}`);
    if (p.name !== undefined) sets.push(`name = ${push(p.name)}`);
    if (p.type !== undefined) sets.push(`type = ${push(p.type)}::machine_type`);
    if (p.brand !== undefined) sets.push(`brand = ${push(p.brand ?? null)}`);
    if (p.model !== undefined) sets.push(`model = ${push(p.model ?? null)}`);
    if (p.serial_number !== undefined) sets.push(`serial_number = ${push(p.serial_number ?? null)}`);
    if (p.hourly_rate !== undefined) sets.push(`hourly_rate = ${push(p.hourly_rate)}`);
    if (p.currency !== undefined) sets.push(`currency = ${push(p.currency)}`);
    if (p.status !== undefined) sets.push(`status = ${push(p.status)}::machine_status`);
    if (p.is_available !== undefined) sets.push(`is_available = ${push(p.is_available)}`);
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
      brand: string | null;
      model: string | null;
      serial_number: string | null;
      image_path: string | null;
      hourly_rate: number;
      currency: string;
      is_available: boolean;
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
        RETURNING
          id::text AS id,
          code,
          name,
          type::text AS type,
          status::text AS status,
          brand,
          model,
          serial_number,
          image_path,
          hourly_rate::float8 AS hourly_rate,
          currency,
          is_available,
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
      status: row.status,
      hourly_rate: Number(row.hourly_rate),
      currency: row.currency,
      is_available: row.is_available,
      image_url: imageUrl(row.image_path),
      image_path: row.image_path,
      archived_at: row.archived_at,
      updated_at: row.updated_at,
      brand: row.brand,
      model: row.model,
      serial_number: row.serial_number,
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

async function selectOfHeader(q: DbQueryer, ofId: number): Promise<Omit<OrdreFabricationDetail, "operations"> | null> {
  type Row = {
    id: string;
    numero: string;
    affaire_id: string | null;
    commande_id: string | null;
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

  return { ...header, operations };
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

    const idRes = await client.query<{ of_id: string }>(
      `SELECT nextval(pg_get_serial_sequence('public.ordres_fabrication','id'))::text AS of_id`
    );
    const rawId = idRes.rows[0]?.of_id;
    const ofId = toInt(rawId, "ordres_fabrication.id");

    const b = params.body;
    const numero = typeof b.numero === "string" && b.numero.trim().length > 0 ? b.numero.trim() : null;
    const numeroForInsert = numero ?? `OF-${ofId}`;

    const ins = await client.query<{ id: string; numero: string }>(
      `
        INSERT INTO ordres_fabrication (
          id,
          numero,
          affaire_id,
          commande_id,
          client_id,
          piece_technique_id,
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
          $5,
          $6::uuid,
          $7,
          $8::of_status,
          $9::of_priority,
          $10::date,
          $11::date,
          $12,
          $13,
          $13
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

    const insOps = await client.query(
      `
        INSERT INTO of_operations (
          of_id,
          phase,
          designation,
          cf_id,
          poste_id,
          machine_id,
          hourly_rate_applied,
          tp,
          tf_unit,
          qte,
          coef,
          temps_total_planned,
          status,
          notes
        )
        SELECT
          $1::bigint AS of_id,
          pto.phase,
          pto.designation,
          pto.cf_id,
          NULL::uuid AS poste_id,
          NULL::uuid AS machine_id,
          COALESCE(pto.taux_horaire, 0)::numeric(12,2) AS hourly_rate_applied,
          COALESCE(pto.tp, 0)::numeric(12,3) AS tp,
          COALESCE(pto.tf_unit, 0)::numeric(12,3) AS tf_unit,
          COALESCE(pto.qte, 1)::numeric(12,3) AS qte,
          COALESCE(pto.coef, 1)::numeric(10,3) AS coef,
          ROUND((COALESCE(pto.tp,0) + COALESCE(pto.tf_unit,0) * COALESCE(pto.qte,1)) * COALESCE(pto.coef,1), 3)::numeric(12,3) AS temps_total_planned,
          'TODO'::of_operation_status AS status,
          pto.designation_2 AS notes
        FROM pieces_techniques_operations pto
        WHERE pto.piece_technique_id = $2::uuid
        ORDER BY pto.phase ASC, pto.id ASC
      `,
      [ofId, b.piece_technique_id]
    );

    await insertAuditLog(client, params.audit, {
      action: "production.of.create",
      entity_type: "ordres_fabrication",
      entity_id: String(ofId),
      details: {
        numero: created.numero,
        piece_technique_id: b.piece_technique_id,
        quantite_lancee: b.quantite_lancee,
        operations_count: insOps.rowCount ?? 0,
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

    const exists = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM ordres_fabrication WHERE id = $1::bigint FOR UPDATE`,
      [params.id]
    );
    if (!exists.rows[0]?.id) {
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
    if (p.poste_id !== undefined) sets.push(`poste_id = ${push(p.poste_id ?? null)}::uuid`);
    if (p.machine_id !== undefined) sets.push(`machine_id = ${push(p.machine_id ?? null)}::uuid`);
    if (p.status !== undefined) {
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

    const op = await client.query<{ id: string; machine_id: string | null }>(
      `
        SELECT id::text AS id, machine_id::text AS machine_id
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

    await client.query(
      `UPDATE ordres_fabrication SET updated_at = now(), updated_by = $2 WHERE id = $1::bigint`,
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
