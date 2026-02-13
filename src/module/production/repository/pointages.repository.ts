import type { PoolClient } from "pg";
import path from "node:path";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";

import type { AuditContext } from "./production.repository";
import type { Paginated } from "../types/production.types";
import type {
  PointageStatus,
  PointageTimeType,
  PointageUserLite,
  ProductionPointageDetail,
  ProductionPointageEvent,
  ProductionPointageListItem,
  ProductionPointagesKpis,
} from "../types/pointages.types";
import type {
  CreatePointageManualBodyDTO,
  ListOperatorsQueryDTO,
  ListPointagesQueryDTO,
  PatchPointageBodyDTO,
  PointagesKpisQueryDTO,
  StartPointageBodyDTO,
  StopPointageBodyDTO,
  ValidatePointageBodyDTO,
} from "../validators/pointages.validators";

type DbQueryer = Pick<PoolClient, "query">;

const BASE_IMAGE_URL = process.env.BACKEND_URL || "http://erp-backend.croix-rousse-precision.fr:8080";

function imageUrl(imagePath: string | null): string | null {
  if (!imagePath) return null;
  return `${BASE_IMAGE_URL}/images/${path.basename(imagePath)}`;
}

function userLabel(params: { username: string; name: string | null; surname: string | null }): string {
  const full = [params.name, params.surname]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .join(" ");
  return full ? `${full} (${params.username})` : params.username;
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

function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

async function insertAuditLog(
  tx: DbQueryer,
  audit: AuditContext,
  entry: {
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    details?: Record<string, unknown> | null;
  }
) {
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

async function insertPointageEvent(
  tx: DbQueryer,
  params: {
    pointage_id: string;
    event_type: string;
    user_id: number;
    old_values: Record<string, unknown> | null;
    new_values: Record<string, unknown> | null;
    note?: string | null;
  }
) {
  await tx.query(
    `
      INSERT INTO production_pointage_events (
        pointage_id,
        event_type,
        old_values,
        new_values,
        user_id,
        note
      )
      VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5, $6)
    `,
    [
      params.pointage_id,
      params.event_type,
      params.old_values ? JSON.stringify(params.old_values) : null,
      params.new_values ? JSON.stringify(params.new_values) : null,
      params.user_id,
      params.note ?? null,
    ]
  );
}

type PointageCoreRow = {
  id: string;
  status: PointageStatus;
  time_type: PointageTimeType;
  start_ts: string;
  end_ts: string | null;
  duration_minutes: number | null;
  comment: string | null;
  correction_reason: string | null;
  validated_at: string | null;
  validated_by_id: number | null;
  validated_by_username: string | null;
  validated_by_name: string | null;
  validated_by_surname: string | null;
  created_at: string;
  updated_at: string;
  created_by_id: number;
  created_by_username: string;
  created_by_name: string | null;
  created_by_surname: string | null;
  updated_by_id: number;
  updated_by_username: string;
  updated_by_name: string | null;
  updated_by_surname: string | null;

  of_id: string;
  of_numero: string;
  of_client_id: string | null;
  of_client_company_name: string | null;
  of_affaire_id: string | null;

  affaire_id: string | null;
  affaire_reference: string | null;

  piece_technique_id: string | null;
  piece_code_piece: string | null;
  piece_designation: string | null;

  operation_id: string | null;
  operation_phase: number | null;
  operation_designation: string | null;

  machine_id: string | null;
  machine_code: string | null;
  machine_name: string | null;
  machine_image_path: string | null;

  poste_id: string | null;
  poste_code: string | null;
  poste_label: string | null;

  operator_id: number;
  operator_username: string;
  operator_name: string | null;
  operator_surname: string | null;
};

function mapUserLite(row: { id: number; username: string; name: string | null; surname: string | null }): PointageUserLite {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    surname: row.surname,
    label: userLabel({ username: row.username, name: row.name, surname: row.surname }),
  };
}

function mapPointageCore(row: PointageCoreRow): Omit<ProductionPointageDetail, "events"> {
  const ofId = toInt(row.of_id, "production_pointages.of_id");
  const affaireId = toNullableInt(row.affaire_id, "production_pointages.affaire_id");
  const ofAffaireId = toNullableInt(row.of_affaire_id, "ordres_fabrication.affaire_id");

  const piece = row.piece_technique_id
    ? {
        id: row.piece_technique_id,
        code_piece: row.piece_code_piece ?? "",
        designation: row.piece_designation ?? "",
      }
    : null;

  const operation = row.operation_id
    ? {
        id: row.operation_id,
        phase: row.operation_phase ?? 0,
        designation: row.operation_designation ?? "",
      }
    : null;

  const machine = row.machine_id
    ? {
        id: row.machine_id,
        code: row.machine_code ?? "",
        name: row.machine_name ?? "",
        image_url: imageUrl(row.machine_image_path),
      }
    : null;

  const poste = row.poste_id
    ? {
        id: row.poste_id,
        code: row.poste_code ?? "",
        label: row.poste_label ?? "",
      }
    : null;

  const operator = mapUserLite({
    id: row.operator_id,
    username: row.operator_username,
    name: row.operator_name,
    surname: row.operator_surname,
  });

  const createdBy = mapUserLite({
    id: row.created_by_id,
    username: row.created_by_username,
    name: row.created_by_name,
    surname: row.created_by_surname,
  });

  const updatedBy = mapUserLite({
    id: row.updated_by_id,
    username: row.updated_by_username,
    name: row.updated_by_name,
    surname: row.updated_by_surname,
  });

  const validatedBy =
    typeof row.validated_by_id === "number" && typeof row.validated_by_username === "string"
      ? mapUserLite({
          id: row.validated_by_id,
          username: row.validated_by_username,
          name: row.validated_by_name,
          surname: row.validated_by_surname,
        })
      : null;

  return {
    id: row.id,
    status: row.status,
    time_type: row.time_type,
    start_ts: row.start_ts,
    end_ts: row.end_ts,
    duration_minutes: row.duration_minutes,
    comment: row.comment,
    correction_reason: row.correction_reason,
    validated_at: row.validated_at,
    validated_by: validatedBy,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: createdBy,
    updated_by: updatedBy,
    of: {
      id: ofId,
      numero: row.of_numero,
      client_id: row.of_client_id,
      client_company_name: row.of_client_company_name,
      affaire_id: ofAffaireId,
    },
    affaire: affaireId && row.affaire_reference ? { id: affaireId, reference: row.affaire_reference } : null,
    piece_technique: piece,
    operation,
    machine,
    poste,
    operator,
  };
}

async function selectPointageCore(q: DbQueryer, id: string): Promise<Omit<ProductionPointageDetail, "events"> | null> {
  const res = await q.query<PointageCoreRow>(
    `
      SELECT
        p.id::text AS id,
        p.status::text AS status,
        p.time_type::text AS time_type,
        p.start_ts::text AS start_ts,
        p.end_ts::text AS end_ts,
        p.duration_minutes::int AS duration_minutes,
        p.comment,
        p.correction_reason,
        p.validated_at::text AS validated_at,

        vb.id AS validated_by_id,
        vb.username AS validated_by_username,
        vb.name AS validated_by_name,
        vb.surname AS validated_by_surname,

        p.created_at::text AS created_at,
        p.updated_at::text AS updated_at,

        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,

        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname,

        o.id::text AS of_id,
        o.numero AS of_numero,
        o.client_id AS of_client_id,
        c.company_name AS of_client_company_name,
        o.affaire_id::text AS of_affaire_id,

        a.id::text AS affaire_id,
        a.reference AS affaire_reference,

        pt.id::text AS piece_technique_id,
        pt.code_piece AS piece_code_piece,
        pt.designation AS piece_designation,

        op.id::text AS operation_id,
        op.phase::int AS operation_phase,
        op.designation AS operation_designation,

        m.id::text AS machine_id,
        m.code AS machine_code,
        m.name AS machine_name,
        m.image_path AS machine_image_path,

        po.id::text AS poste_id,
        po.code AS poste_code,
        po.label AS poste_label,

        ou.id AS operator_id,
        ou.username AS operator_username,
        ou.name AS operator_name,
        ou.surname AS operator_surname
      FROM production_pointages p
      JOIN ordres_fabrication o ON o.id = p.of_id
      LEFT JOIN clients c ON c.client_id = o.client_id
      LEFT JOIN affaire a ON a.id = COALESCE(p.affaire_id, o.affaire_id)
      LEFT JOIN pieces_techniques pt ON pt.id = COALESCE(p.piece_technique_id, o.piece_technique_id)
      LEFT JOIN of_operations op ON op.id = p.operation_id
      LEFT JOIN machines m ON m.id = p.machine_id
      LEFT JOIN postes po ON po.id = p.poste_id
      JOIN users ou ON ou.id = p.operator_user_id
      JOIN users cb ON cb.id = p.created_by
      JOIN users ub ON ub.id = p.updated_by
      LEFT JOIN users vb ON vb.id = p.validated_by
      WHERE p.id = $1::uuid
      LIMIT 1
    `,
    [id]
  );
  const row = res.rows[0];
  return row ? mapPointageCore(row) : null;
}

async function selectPointageEvents(q: DbQueryer, id: string): Promise<ProductionPointageEvent[]> {
  type EventRow = {
    id: number;
    pointage_id: string;
    event_type: string;
    old_values: unknown | null;
    new_values: unknown | null;
    user_id: number;
    username: string;
    name: string | null;
    surname: string | null;
    created_at: string;
    note: string | null;
  };

  const res = await q.query<EventRow>(
    `
      SELECT
        e.id::int AS id,
        e.pointage_id::text AS pointage_id,
        e.event_type,
        e.old_values,
        e.new_values,
        u.id AS user_id,
        u.username,
        u.name,
        u.surname,
        e.created_at::text AS created_at,
        e.note
      FROM production_pointage_events e
      JOIN users u ON u.id = e.user_id
      WHERE e.pointage_id = $1::uuid
      ORDER BY e.created_at ASC, e.id ASC
    `,
    [id]
  );

  return res.rows.map((r) => ({
    id: r.id,
    pointage_id: r.pointage_id,
    event_type: r.event_type,
    old_values: r.old_values,
    new_values: r.new_values,
    user: mapUserLite({ id: r.user_id, username: r.username, name: r.name, surname: r.surname }),
    created_at: r.created_at,
    note: r.note,
  }));
}

type PointageSnapshot = {
  status: PointageStatus;
  time_type: PointageTimeType;
  start_ts: string;
  end_ts: string | null;
  duration_minutes: number | null;
  of_id: number;
  operation_id: string | null;
  affaire_id: number | null;
  piece_technique_id: string | null;
  machine_id: string | null;
  poste_id: string | null;
  operator_user_id: number;
  comment: string | null;
  correction_reason: string | null;
  validated_by: number | null;
  validated_at: string | null;
  updated_by: number;
  updated_at: string;
};

async function selectPointageSnapshot(q: DbQueryer, id: string): Promise<PointageSnapshot | null> {
  type Row = {
    status: PointageStatus;
    time_type: PointageTimeType;
    start_ts: string;
    end_ts: string | null;
    duration_minutes: number | null;
    of_id: string;
    operation_id: string | null;
    affaire_id: string | null;
    piece_technique_id: string | null;
    machine_id: string | null;
    poste_id: string | null;
    operator_user_id: number;
    comment: string | null;
    correction_reason: string | null;
    validated_by: number | null;
    validated_at: string | null;
    updated_by: number;
    updated_at: string;
  };

  const res = await q.query<Row>(
    `
      SELECT
        status::text AS status,
        time_type::text AS time_type,
        start_ts::text AS start_ts,
        end_ts::text AS end_ts,
        duration_minutes::int AS duration_minutes,
        of_id::text AS of_id,
        operation_id::text AS operation_id,
        affaire_id::text AS affaire_id,
        piece_technique_id::text AS piece_technique_id,
        machine_id::text AS machine_id,
        poste_id::text AS poste_id,
        operator_user_id,
        comment,
        correction_reason,
        validated_by,
        validated_at::text AS validated_at,
        updated_by,
        updated_at::text AS updated_at
      FROM production_pointages
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [id]
  );
  const row = res.rows[0];
  if (!row) return null;

  return {
    status: row.status,
    time_type: row.time_type,
    start_ts: row.start_ts,
    end_ts: row.end_ts,
    duration_minutes: row.duration_minutes,
    of_id: toInt(row.of_id, "production_pointages.of_id"),
    operation_id: row.operation_id,
    affaire_id: toNullableInt(row.affaire_id, "production_pointages.affaire_id"),
    piece_technique_id: row.piece_technique_id,
    machine_id: row.machine_id,
    poste_id: row.poste_id,
    operator_user_id: row.operator_user_id,
    comment: row.comment,
    correction_reason: row.correction_reason,
    validated_by: row.validated_by,
    validated_at: row.validated_at,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  };
}

export async function repoGetPointage(id: string): Promise<ProductionPointageDetail | null> {
  const core = await selectPointageCore(pool, id);
  if (!core) return null;
  const events = await selectPointageEvents(pool, id);
  return { ...core, events };
}

function pointageSortColumn(sortBy: ListPointagesQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "end_ts":
      return "p.end_ts";
    case "duration_minutes":
      return "p.duration_minutes";
    case "updated_at":
      return "p.updated_at";
    case "start_ts":
    default:
      return "p.start_ts";
  }
}

function pointageSortDir(dir: ListPointagesQueryDTO["sortDir"]): "ASC" | "DESC" {
  return dir === "asc" ? "ASC" : "DESC";
}

export async function repoListPointages(filters: ListPointagesQueryDTO): Promise<Paginated<ProductionPointageListItem>> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.date_from) where.push(`p.start_ts >= ${push(filters.date_from)}::date`);
  if (filters.date_to) where.push(`p.start_ts < (${push(filters.date_to)}::date + interval '1 day')`);
  if (typeof filters.of_id === "number") where.push(`p.of_id = ${push(filters.of_id)}::bigint`);
  if (filters.machine_id) where.push(`p.machine_id = ${push(filters.machine_id)}::uuid`);
  if (filters.poste_id) where.push(`p.poste_id = ${push(filters.poste_id)}::uuid`);
  if (typeof filters.operator_user_id === "number") where.push(`p.operator_user_id = ${push(filters.operator_user_id)}`);
  if (filters.time_type) where.push(`p.time_type = ${push(filters.time_type)}::production_pointage_time_type`);
  if (filters.status) where.push(`p.status = ${push(filters.status)}::production_pointage_status`);

  if (filters.q && filters.q.trim().length > 0) {
    const q = `%${filters.q.trim()}%`;
    const p = push(q);
    where.push(`(
      o.numero ILIKE ${p}
      OR COALESCE(a.reference,'') ILIKE ${p}
      OR COALESCE(pt.code_piece,'') ILIKE ${p}
      OR COALESCE(pt.designation,'') ILIKE ${p}
      OR COALESCE(op.designation,'') ILIKE ${p}
      OR COALESCE(m.code,'') ILIKE ${p}
      OR COALESCE(m.name,'') ILIKE ${p}
      OR COALESCE(po.code,'') ILIKE ${p}
      OR COALESCE(po.label,'') ILIKE ${p}
      OR COALESCE(ou.username,'') ILIKE ${p}
      OR COALESCE(ou.name,'') ILIKE ${p}
      OR COALESCE(ou.surname,'') ILIKE ${p}
      OR COALESCE(p.comment,'') ILIKE ${p}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const baseJoinSql = `
    FROM production_pointages p
    JOIN ordres_fabrication o ON o.id = p.of_id
    LEFT JOIN clients c ON c.client_id = o.client_id
    LEFT JOIN affaire a ON a.id = COALESCE(p.affaire_id, o.affaire_id)
    LEFT JOIN pieces_techniques pt ON pt.id = COALESCE(p.piece_technique_id, o.piece_technique_id)
    LEFT JOIN of_operations op ON op.id = p.operation_id
    LEFT JOIN machines m ON m.id = p.machine_id
    LEFT JOIN postes po ON po.id = p.poste_id
    JOIN users ou ON ou.id = p.operator_user_id
  `;

  const countRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total ${baseJoinSql} ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  type Row = {
    id: string;
    status: PointageStatus;
    time_type: PointageTimeType;
    start_ts: string;
    end_ts: string | null;
    duration_minutes: number | null;
    comment: string | null;

    of_id: string;
    of_numero: string;
    of_client_id: string | null;
    of_client_company_name: string | null;
    of_affaire_id: string | null;

    affaire_id: string | null;
    affaire_reference: string | null;

    piece_technique_id: string | null;
    piece_code_piece: string | null;
    piece_designation: string | null;

    operation_id: string | null;
    operation_phase: number | null;
    operation_designation: string | null;

    machine_id: string | null;
    machine_code: string | null;
    machine_name: string | null;
    machine_image_path: string | null;

    poste_id: string | null;
    poste_code: string | null;
    poste_label: string | null;

    operator_id: number;
    operator_username: string;
    operator_name: string | null;
    operator_surname: string | null;
  };

  const orderBy = pointageSortColumn(filters.sortBy);
  const orderDir = pointageSortDir(filters.sortDir);

  const dataRes = await pool.query<Row>(
    `
      SELECT
        p.id::text AS id,
        p.status::text AS status,
        p.time_type::text AS time_type,
        p.start_ts::text AS start_ts,
        p.end_ts::text AS end_ts,
        p.duration_minutes::int AS duration_minutes,
        p.comment,

        o.id::text AS of_id,
        o.numero AS of_numero,
        o.client_id AS of_client_id,
        c.company_name AS of_client_company_name,
        o.affaire_id::text AS of_affaire_id,

        a.id::text AS affaire_id,
        a.reference AS affaire_reference,

        pt.id::text AS piece_technique_id,
        pt.code_piece AS piece_code_piece,
        pt.designation AS piece_designation,

        op.id::text AS operation_id,
        op.phase::int AS operation_phase,
        op.designation AS operation_designation,

        m.id::text AS machine_id,
        m.code AS machine_code,
        m.name AS machine_name,
        m.image_path AS machine_image_path,

        po.id::text AS poste_id,
        po.code AS poste_code,
        po.label AS poste_label,

        ou.id AS operator_id,
        ou.username AS operator_username,
        ou.name AS operator_name,
        ou.surname AS operator_surname
      ${baseJoinSql}
      ${whereSql}
      ORDER BY ${orderBy} ${orderDir}, p.id ${orderDir}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  );

  const items: ProductionPointageListItem[] = dataRes.rows.map((r) => {
    const ofId = toInt(r.of_id, "production_pointages.of_id");
    const ofAffaireId = toNullableInt(r.of_affaire_id, "ordres_fabrication.affaire_id");
    const affaireId = toNullableInt(r.affaire_id, "production_pointages.affaire_id");

    const piece = r.piece_technique_id
      ? { id: r.piece_technique_id, code_piece: r.piece_code_piece ?? "", designation: r.piece_designation ?? "" }
      : null;
    const op = r.operation_id
      ? { id: r.operation_id, phase: r.operation_phase ?? 0, designation: r.operation_designation ?? "" }
      : null;
    const machine = r.machine_id
      ? {
          id: r.machine_id,
          code: r.machine_code ?? "",
          name: r.machine_name ?? "",
          image_url: imageUrl(r.machine_image_path),
        }
      : null;
    const poste = r.poste_id ? { id: r.poste_id, code: r.poste_code ?? "", label: r.poste_label ?? "" } : null;
    const operator = mapUserLite({
      id: r.operator_id,
      username: r.operator_username,
      name: r.operator_name,
      surname: r.operator_surname,
    });

    return {
      id: r.id,
      status: r.status,
      time_type: r.time_type,
      start_ts: r.start_ts,
      end_ts: r.end_ts,
      duration_minutes: r.duration_minutes,
      comment: r.comment,
      of: {
        id: ofId,
        numero: r.of_numero,
        client_id: r.of_client_id,
        client_company_name: r.of_client_company_name,
        affaire_id: ofAffaireId,
      },
      affaire: affaireId && r.affaire_reference ? { id: affaireId, reference: r.affaire_reference } : null,
      piece_technique: piece,
      operation: op,
      machine,
      poste,
      operator,
    };
  });

  return { items, total };
}

async function ensureOfExists(tx: DbQueryer, ofId: number) {
  type Row = {
    id: string;
    affaire_id: string | null;
    piece_technique_id: string;
  };

  const res = await tx.query<Row>(
    `
      SELECT id::text AS id, affaire_id::text AS affaire_id, piece_technique_id::text AS piece_technique_id
      FROM ordres_fabrication
      WHERE id = $1::bigint
      LIMIT 1
    `,
    [ofId]
  );

  const row = res.rows[0];
  if (!row) throw new HttpError(404, "OF_NOT_FOUND", "Ordre de fabrication introuvable");
  return {
    id: toInt(row.id, "ordres_fabrication.id"),
    affaire_id: toNullableInt(row.affaire_id, "ordres_fabrication.affaire_id"),
    piece_technique_id: row.piece_technique_id,
  };
}

async function ensureOperationBelongsToOf(tx: DbQueryer, params: { of_id: number; operation_id: string }) {
  const res = await tx.query<{ id: string }>(
    `
      SELECT id::text AS id
      FROM of_operations
      WHERE id = $1::uuid AND of_id = $2::bigint
      LIMIT 1
    `,
    [params.operation_id, params.of_id]
  );
  if (!res.rows[0]?.id) {
    throw new HttpError(409, "OPERATION_OF_MISMATCH", "Operation does not belong to the given OF");
  }
}

export async function repoCreatePointageManual(params: {
  body: CreatePointageManualBodyDTO;
  audit: AuditContext;
}): Promise<ProductionPointageDetail> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ofDefaults = await ensureOfExists(client, params.body.of_id);

    if (params.body.operation_id) {
      await ensureOperationBelongsToOf(client, { of_id: params.body.of_id, operation_id: params.body.operation_id });
    }

    if (
      typeof params.body.affaire_id === "number" &&
      ofDefaults.affaire_id &&
      params.body.affaire_id !== ofDefaults.affaire_id
    ) {
      throw new HttpError(409, "AFFAIRE_OF_MISMATCH", "Affaire does not match the given OF");
    }

    if (params.body.piece_technique_id && params.body.piece_technique_id !== ofDefaults.piece_technique_id) {
      throw new HttpError(409, "PIECE_TECHNIQUE_OF_MISMATCH", "Piece technique does not match the given OF");
    }

    const affaireId = typeof params.body.affaire_id === "number" ? params.body.affaire_id : ofDefaults.affaire_id;
    const pieceTechId = params.body.piece_technique_id ?? ofDefaults.piece_technique_id;

    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO production_pointages (
          of_id,
          affaire_id,
          piece_technique_id,
          operation_id,
          machine_id,
          poste_id,
          operator_user_id,
          time_type,
          start_ts,
          end_ts,
          status,
          comment,
          correction_reason,
          created_by,
          updated_by
        )
        VALUES (
          $1::bigint,
          $2::bigint,
          $3::uuid,
          $4::uuid,
          $5::uuid,
          $6::uuid,
          $7,
          $8::production_pointage_time_type,
          $9::timestamptz,
          $10::timestamptz,
          'DONE'::production_pointage_status,
          $11,
          NULL,
          $12,
          $12
        )
        RETURNING id::text AS id
      `,
      [
        params.body.of_id,
        affaireId,
        pieceTechId,
        params.body.operation_id ?? null,
        params.body.machine_id ?? null,
        params.body.poste_id ?? null,
        params.body.operator_user_id,
        params.body.time_type,
        params.body.start_ts,
        params.body.end_ts,
        params.body.comment ?? null,
        params.audit.user_id,
      ]
    );

    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to create pointage");

    const after = await selectPointageSnapshot(client, id);

    await insertPointageEvent(client, {
      pointage_id: id,
      event_type: "CREATE_MANUAL",
      user_id: params.audit.user_id,
      old_values: null,
      new_values: after,
    });

    await insertAuditLog(client, params.audit, {
      action: "production.pointages.create_manual",
      entity_type: "production_pointages",
      entity_id: id,
      details: {
        of_id: params.body.of_id,
        operator_user_id: params.body.operator_user_id,
        time_type: params.body.time_type,
      },
    });

    await client.query("COMMIT");

    const out = await repoGetPointage(id);
    if (!out) throw new Error("Failed to reload created pointage");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "POINTAGE_CONFLICT", "Conflicting pointage (RUNNING overlap or duplicate)");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoStartPointage(params: {
  id: string;
  body: StartPointageBodyDTO;
  audit: AuditContext;
}): Promise<ProductionPointageDetail> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM production_pointages WHERE id = $1::uuid LIMIT 1`,
      [params.id]
    );
    if (exists.rows[0]?.id) {
      throw new HttpError(409, "POINTAGE_ALREADY_EXISTS", "Pointage already exists");
    }

    const ofDefaults = await ensureOfExists(client, params.body.of_id);
    if (params.body.operation_id) {
      await ensureOperationBelongsToOf(client, { of_id: params.body.of_id, operation_id: params.body.operation_id });
    }

    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO production_pointages (
          id,
          of_id,
          affaire_id,
          piece_technique_id,
          operation_id,
          machine_id,
          poste_id,
          operator_user_id,
          time_type,
          start_ts,
          end_ts,
          status,
          comment,
          correction_reason,
          created_by,
          updated_by
        )
        VALUES (
          $1::uuid,
          $2::bigint,
          $3::bigint,
          $4::uuid,
          $5::uuid,
          $6::uuid,
          $7::uuid,
          $8,
          $9::production_pointage_time_type,
          now(),
          NULL,
          'RUNNING'::production_pointage_status,
          $10,
          NULL,
          $11,
          $11
        )
        RETURNING id::text AS id
      `,
      [
        params.id,
        params.body.of_id,
        ofDefaults.affaire_id,
        ofDefaults.piece_technique_id,
        params.body.operation_id ?? null,
        params.body.machine_id ?? null,
        params.body.poste_id ?? null,
        params.body.operator_user_id,
        params.body.time_type,
        params.body.comment ?? null,
        params.audit.user_id,
      ]
    );

    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to start pointage");

    const after = await selectPointageSnapshot(client, id);

    await insertPointageEvent(client, {
      pointage_id: id,
      event_type: "START",
      user_id: params.audit.user_id,
      old_values: null,
      new_values: after,
    });

    await insertAuditLog(client, params.audit, {
      action: "production.pointages.start",
      entity_type: "production_pointages",
      entity_id: id,
      details: {
        of_id: params.body.of_id,
        operator_user_id: params.body.operator_user_id,
        time_type: params.body.time_type,
      },
    });

    await client.query("COMMIT");

    const out = await repoGetPointage(id);
    if (!out) throw new Error("Failed to reload started pointage");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "POINTAGE_RUNNING_CONFLICT", "A RUNNING pointage already exists for this operator/machine");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoStopPointage(params: {
  id: string;
  body: StopPointageBodyDTO;
  audit: AuditContext;
}): Promise<ProductionPointageDetail | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    type LockRow = {
      id: string;
      status: PointageStatus;
      start_ts: string;
      end_ts: string | null;
      operator_user_id: number;
      machine_id: string | null;
      poste_id: string | null;
      time_type: PointageTimeType;
      of_id: string;
      operation_id: string | null;
      comment: string | null;
      correction_reason: string | null;
    };

    const beforeRes = await client.query<LockRow>(
      `
        SELECT
          id::text AS id,
          status::text AS status,
          start_ts::text AS start_ts,
          end_ts::text AS end_ts,
          operator_user_id,
          machine_id::text AS machine_id,
          poste_id::text AS poste_id,
          time_type::text AS time_type,
          of_id::text AS of_id,
          operation_id::text AS operation_id,
          comment,
          correction_reason
        FROM production_pointages
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [params.id]
    );

    const before = beforeRes.rows[0];
    if (!before) {
      await client.query("ROLLBACK");
      return null;
    }
    if (before.status !== "RUNNING") {
      throw new HttpError(409, "POINTAGE_NOT_RUNNING", "Pointage is not RUNNING");
    }

    await client.query(
      `
        UPDATE production_pointages
        SET
          end_ts = now(),
          status = 'DONE'::production_pointage_status,
          comment = COALESCE($2, comment),
          updated_by = $3,
          updated_at = now()
        WHERE id = $1::uuid
      `,
      [params.id, params.body.comment ?? null, params.audit.user_id]
    );

    const after = await selectPointageSnapshot(client, params.id);

    await insertPointageEvent(client, {
      pointage_id: params.id,
      event_type: "STOP",
      user_id: params.audit.user_id,
      old_values: {
        status: before.status,
        start_ts: before.start_ts,
        end_ts: before.end_ts,
        operator_user_id: before.operator_user_id,
        machine_id: before.machine_id,
        poste_id: before.poste_id,
        time_type: before.time_type,
        of_id: toInt(before.of_id, "production_pointages.of_id"),
        operation_id: before.operation_id,
        comment: before.comment,
        correction_reason: before.correction_reason,
      },
      new_values: after,
    });

    await insertAuditLog(client, params.audit, {
      action: "production.pointages.stop",
      entity_type: "production_pointages",
      entity_id: params.id,
      details: {
        of_id: toInt(before.of_id, "production_pointages.of_id"),
        operator_user_id: before.operator_user_id,
        time_type: before.time_type,
      },
    });

    await client.query("COMMIT");

    const out = await repoGetPointage(params.id);
    if (!out) throw new Error("Failed to reload stopped pointage");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoPatchPointage(params: {
  id: string;
  body: PatchPointageBodyDTO;
  audit: AuditContext;
}): Promise<ProductionPointageDetail | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    type LockRow = {
      id: string;
      status: PointageStatus;
      start_ts: string;
      end_ts: string | null;
      validated_at: string | null;
      of_id: string;
      operation_id: string | null;
      affaire_id: string | null;
      piece_technique_id: string | null;
      machine_id: string | null;
      poste_id: string | null;
      operator_user_id: number;
      time_type: PointageTimeType;
      comment: string | null;
      correction_reason: string | null;
    };

    const beforeRes = await client.query<LockRow>(
      `
        SELECT
          id::text AS id,
          status::text AS status,
          start_ts::text AS start_ts,
          end_ts::text AS end_ts,
          validated_at::text AS validated_at,
          of_id::text AS of_id,
          operation_id::text AS operation_id,
          affaire_id::text AS affaire_id,
          piece_technique_id::text AS piece_technique_id,
          machine_id::text AS machine_id,
          poste_id::text AS poste_id,
          operator_user_id,
          time_type::text AS time_type,
          comment,
          correction_reason
        FROM production_pointages
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [params.id]
    );

    const before = beforeRes.rows[0];
    if (!before) {
      await client.query("ROLLBACK");
      return null;
    }

    if (before.validated_at) {
      throw new HttpError(409, "POINTAGE_LOCKED", "Validated pointage cannot be edited");
    }

    const patch = params.body.patch;

    const nextOfId =
      typeof patch.of_id === "number" ? patch.of_id : toInt(before.of_id, "production_pointages.of_id");
    const ofDefaults = await ensureOfExists(client, nextOfId);

    const nextOperationId = patch.operation_id !== undefined ? patch.operation_id : before.operation_id;
    if (typeof nextOperationId === "string") {
      await ensureOperationBelongsToOf(client, { of_id: nextOfId, operation_id: nextOperationId });
    }

    const nextAffaireId =
      patch.affaire_id !== undefined
        ? patch.affaire_id
        : before.affaire_id
          ? toNullableInt(before.affaire_id, "production_pointages.affaire_id")
          : null;
    if (typeof nextAffaireId === "number" && ofDefaults.affaire_id && nextAffaireId !== ofDefaults.affaire_id) {
      throw new HttpError(409, "AFFAIRE_OF_MISMATCH", "Affaire does not match the given OF");
    }

    const nextPieceTechId =
      patch.piece_technique_id !== undefined ? patch.piece_technique_id : before.piece_technique_id ?? null;
    if (typeof nextPieceTechId === "string" && nextPieceTechId !== ofDefaults.piece_technique_id) {
      throw new HttpError(409, "PIECE_TECHNIQUE_OF_MISMATCH", "Piece technique does not match the given OF");
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (patch.of_id !== undefined) sets.push(`of_id = ${push(nextOfId)}::bigint`);
    if (patch.operation_id !== undefined) sets.push(`operation_id = ${push(patch.operation_id ?? null)}::uuid`);
    if (patch.affaire_id !== undefined) {
      const v = patch.affaire_id === null ? null : patch.affaire_id;
      sets.push(`affaire_id = ${push(v)}::bigint`);
    }
    if (patch.piece_technique_id !== undefined)
      sets.push(`piece_technique_id = ${push(patch.piece_technique_id ?? null)}::uuid`);
    if (patch.machine_id !== undefined) sets.push(`machine_id = ${push(patch.machine_id ?? null)}::uuid`);
    if (patch.poste_id !== undefined) sets.push(`poste_id = ${push(patch.poste_id ?? null)}::uuid`);
    if (patch.operator_user_id !== undefined) sets.push(`operator_user_id = ${push(patch.operator_user_id)}`);
    if (patch.time_type !== undefined) sets.push(`time_type = ${push(patch.time_type)}::production_pointage_time_type`);
    if (patch.start_ts !== undefined) sets.push(`start_ts = ${push(patch.start_ts)}::timestamptz`);
    if (patch.end_ts !== undefined) sets.push(`end_ts = ${push(patch.end_ts ?? null)}::timestamptz`);
    if (patch.comment !== undefined) sets.push(`comment = ${push(patch.comment ?? null)}`);

    sets.push(`correction_reason = ${push(params.body.correction_reason)}`);

    const isCancel = patch.status === "CANCELLED";

    if (isCancel) {
      sets.push(`status = 'CANCELLED'::production_pointage_status`);
      if (before.end_ts === null && patch.end_ts === undefined) {
        sets.push(`end_ts = now()`);
      }
    } else {
      const nextEndIsNull = patch.end_ts !== undefined ? patch.end_ts === null : before.end_ts === null;
      sets.push(
        nextEndIsNull
          ? `status = 'RUNNING'::production_pointage_status`
          : `status = 'CORRECTED'::production_pointage_status`
      );
    }

    sets.push(`updated_by = ${push(params.audit.user_id)}`);
    sets.push(`updated_at = now()`);

    const upd = await client.query<{ id: string }>(
      `
        UPDATE production_pointages
        SET ${sets.join(", ")}
        WHERE id = ${push(params.id)}::uuid
        RETURNING id::text AS id
      `,
      values
    );
    const updatedId = upd.rows[0]?.id;
    if (!updatedId) {
      await client.query("ROLLBACK");
      return null;
    }

    const after = await selectPointageSnapshot(client, updatedId);

    await insertPointageEvent(client, {
      pointage_id: updatedId,
      event_type: isCancel ? "CANCEL" : "CORRECTION",
      user_id: params.audit.user_id,
      old_values: {
        status: before.status,
        start_ts: before.start_ts,
        end_ts: before.end_ts,
        of_id: toInt(before.of_id, "production_pointages.of_id"),
        operation_id: before.operation_id,
        affaire_id: toNullableInt(before.affaire_id, "production_pointages.affaire_id"),
        piece_technique_id: before.piece_technique_id,
        machine_id: before.machine_id,
        poste_id: before.poste_id,
        operator_user_id: before.operator_user_id,
        time_type: before.time_type,
        comment: before.comment,
        correction_reason: before.correction_reason,
      },
      new_values: after,
      note: params.body.correction_reason,
    });

    await insertAuditLog(client, params.audit, {
      action: isCancel ? "production.pointages.cancel" : "production.pointages.correct",
      entity_type: "production_pointages",
      entity_id: updatedId,
      details: { reason: params.body.correction_reason },
    });

    await client.query("COMMIT");

    const out = await repoGetPointage(updatedId);
    if (!out) throw new Error("Failed to reload patched pointage");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "POINTAGE_RUNNING_CONFLICT", "A RUNNING pointage already exists for this operator/machine");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoValidatePointage(params: {
  id: string;
  body: ValidatePointageBodyDTO;
  audit: AuditContext;
}): Promise<ProductionPointageDetail | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await client.query<{ id: string; status: PointageStatus; validated_at: string | null }>(
      `
        SELECT id::text AS id, status::text AS status, validated_at::text AS validated_at
        FROM production_pointages
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [params.id]
    );
    const row = before.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    if (row.status === "RUNNING") {
      throw new HttpError(409, "POINTAGE_RUNNING", "Cannot validate a RUNNING pointage");
    }
    if (row.validated_at) {
      throw new HttpError(409, "POINTAGE_ALREADY_VALIDATED", "Pointage already validated");
    }

    await client.query(
      `
        UPDATE production_pointages
        SET validated_by = $2, validated_at = now(), updated_by = $2, updated_at = now()
        WHERE id = $1::uuid
      `,
      [params.id, params.audit.user_id]
    );

    const after = await selectPointageSnapshot(client, params.id);

    await insertPointageEvent(client, {
      pointage_id: params.id,
      event_type: "VALIDATION",
      user_id: params.audit.user_id,
      old_values: { validated_at: null, validated_by: null },
      new_values: after,
      note: params.body.note ?? null,
    });

    await insertAuditLog(client, params.audit, {
      action: "production.pointages.validate",
      entity_type: "production_pointages",
      entity_id: params.id,
      details: { note: params.body.note ?? null },
    });

    await client.query("COMMIT");

    const out = await repoGetPointage(params.id);
    if (!out) throw new Error("Failed to reload validated pointage");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoPointagesKpis(filters: PointagesKpisQueryDTO): Promise<ProductionPointagesKpis> {
  type Row = {
    total_minutes: number;
    running_count: number;
    operateur_minutes: number;
    machine_minutes: number;
    programmation_minutes: number;
  };

  const res = await pool.query<Row>(
    `
      SELECT
        COALESCE(SUM(p.duration_minutes) FILTER (WHERE p.status <> 'CANCELLED' AND p.end_ts IS NOT NULL), 0)::int AS total_minutes,
        COUNT(*) FILTER (WHERE p.status = 'RUNNING')::int AS running_count,
        COALESCE(SUM(p.duration_minutes) FILTER (WHERE p.status <> 'CANCELLED' AND p.end_ts IS NOT NULL AND p.time_type = 'OPERATEUR'), 0)::int AS operateur_minutes,
        COALESCE(SUM(p.duration_minutes) FILTER (WHERE p.status <> 'CANCELLED' AND p.end_ts IS NOT NULL AND p.time_type = 'MACHINE'), 0)::int AS machine_minutes,
        COALESCE(SUM(p.duration_minutes) FILTER (WHERE p.status <> 'CANCELLED' AND p.end_ts IS NOT NULL AND p.time_type = 'PROGRAMMATION'), 0)::int AS programmation_minutes
      FROM production_pointages p
      WHERE p.start_ts >= $1::date
        AND p.start_ts < ($2::date + interval '1 day')
    `,
    [filters.date_from, filters.date_to]
  );
  const row = res.rows[0];

  return {
    range: { from: filters.date_from, to: filters.date_to },
    kpis: {
      total_minutes: row?.total_minutes ?? 0,
      running_count: row?.running_count ?? 0,
      by_type_minutes: {
        OPERATEUR: row?.operateur_minutes ?? 0,
        MACHINE: row?.machine_minutes ?? 0,
        PROGRAMMATION: row?.programmation_minutes ?? 0,
      },
    },
  };
}

export async function repoListOperators(filters: ListOperatorsQueryDTO): Promise<PointageUserLite[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  const q = (filters.q ?? "").trim();
  if (q.length > 0) {
    const p = push(`%${q}%`);
    where.push(`(
      u.username ILIKE ${p}
      OR COALESCE(u.name,'') ILIKE ${p}
      OR COALESCE(u.surname,'') ILIKE ${p}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);

  type Row = { id: number; username: string; name: string | null; surname: string | null };
  const res = await pool.query<Row>(
    `
      SELECT u.id, u.username, u.name, u.surname
      FROM users u
      ${whereSql}
      ORDER BY u.username ASC, u.id ASC
      LIMIT $${values.length + 1}
    `,
    [...values, limit]
  );

  return res.rows.map((r) => mapUserLite(r));
}
