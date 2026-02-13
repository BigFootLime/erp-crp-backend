import type { PoolClient } from "pg";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";

import type {
  CreateActionBodyDTO,
  CreateControlBodyDTO,
  CreateNonConformityBodyDTO,
  KpisQueryDTO,
  ListActionsQueryDTO,
  ListControlsQueryDTO,
  ListNonConformitiesQueryDTO,
  ListUsersQueryDTO,
  PatchActionBodyDTO,
  PatchControlBodyDTO,
  PatchNonConformityBodyDTO,
  QualityDocumentTypeDTO,
  QualityEntityTypeDTO,
  ValidateControlBodyDTO,
} from "../validators/qualite.validators";
import type {
  NonConformityDetail,
  NonConformityListItem,
  Paginated,
  QualityActionDetail,
  QualityActionListItem,
  QualityControlDetail,
  QualityControlListItem,
  QualityControlPoint,
  QualityControlResult,
  QualityDocument,
  QualityEntityType,
  QualityEventLog,
  QualityKpis,
  QualityPointResult,
  QualityUserLite,
} from "../types/qualite.types";

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
type UploadedDocument = Express.Multer.File;

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function toNullableInt(value: unknown, label = "id"): number | null {
  if (value === null || value === undefined) return null;
  return toInt(value, label);
}

function userLabel(u: { username: string; name: string | null; surname: string | null }): string {
  const full = `${u.name ?? ""} ${u.surname ?? ""}`.trim();
  return full.length ? full : u.username;
}

function mapUserLite(row: { id: number; username: string; name: string | null; surname: string | null }): QualityUserLite {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    surname: row.surname,
    label: userLabel({ username: row.username, name: row.name, surname: row.surname }),
  };
}

async function insertAuditLog(
  tx: DbQueryer,
  audit: AuditContext,
  entry: { action: string; entity_type: string | null; entity_id: string | null; details?: Record<string, unknown> | null }
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

async function insertQualityEvent(
  tx: DbQueryer,
  params: {
    entity_type: QualityEntityType;
    entity_id: string;
    event_type: string;
    user_id: number;
    old_values: Record<string, unknown> | null;
    new_values: Record<string, unknown> | null;
  }
) {
  await tx.query(
    `
      INSERT INTO quality_event_log (
        entity_type,
        entity_id,
        event_type,
        old_values,
        new_values,
        user_id
      )
      VALUES ($1::quality_entity_type, $2::uuid, $3, $4::jsonb, $5::jsonb, $6)
    `,
    [
      params.entity_type,
      params.entity_id,
      params.event_type,
      params.old_values ? JSON.stringify(params.old_values) : null,
      params.new_values ? JSON.stringify(params.new_values) : null,
      params.user_id,
    ]
  );
}

function computePointResult(p: {
  nominal_value: number | null;
  tolerance_min: number | null;
  tolerance_max: number | null;
  measured_value: number | null;
}): QualityPointResult | null {
  if (p.measured_value === null || p.measured_value === undefined) return null;

  const measured = Number(p.measured_value);
  if (!Number.isFinite(measured)) return null;

  let min: number | null = null;
  let max: number | null = null;

  if (p.nominal_value !== null && p.nominal_value !== undefined && (p.tolerance_min !== null || p.tolerance_max !== null)) {
    if (p.tolerance_min !== null && p.tolerance_min !== undefined) min = Number(p.nominal_value) + Number(p.tolerance_min);
    if (p.tolerance_max !== null && p.tolerance_max !== undefined) max = Number(p.nominal_value) + Number(p.tolerance_max);
  } else {
    if (p.tolerance_min !== null && p.tolerance_min !== undefined) min = Number(p.tolerance_min);
    if (p.tolerance_max !== null && p.tolerance_max !== undefined) max = Number(p.tolerance_max);
  }

  if (min === null && max === null) return null;
  if (min !== null && measured < min) return "NOK";
  if (max !== null && measured > max) return "NOK";
  return "OK";
}

function computeControlResult(points: Array<{ result: QualityPointResult | null }>): QualityControlResult {
  if (points.length === 0) return "PARTIAL";
  if (points.some((p) => p.result === "NOK")) return "NOK";
  if (points.every((p) => p.result === "OK")) return "OK";
  return "PARTIAL";
}

type ControlCoreRow = {
  id: string;
  control_type: QualityControlListItem["control_type"];
  status: QualityControlListItem["status"];
  result: QualityControlListItem["result"];
  control_date: string;
  comments: string | null;
  validation_date: string | null;
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

  controlled_by_id: number;
  controlled_by_username: string;
  controlled_by_name: string | null;
  controlled_by_surname: string | null;

  validated_by_id: number | null;
  validated_by_username: string | null;
  validated_by_name: string | null;
  validated_by_surname: string | null;

  affaire_id: string | null;
  affaire_reference: string | null;
  affaire_client_id: string | null;
  affaire_client_company_name: string | null;

  of_id: string | null;
  of_numero: string | null;
  of_client_id: string | null;
  of_client_company_name: string | null;
  of_affaire_id: string | null;

  piece_technique_id: string | null;
  piece_code_piece: string | null;
  piece_designation: string | null;

  operation_id: string | null;
  operation_phase: number | null;
  operation_designation: string | null;

  machine_id: string | null;
  machine_code: string | null;
  machine_name: string | null;

  poste_id: string | null;
  poste_code: string | null;
  poste_label: string | null;
};

function mapControlCore(row: ControlCoreRow): Omit<QualityControlDetail, "points" | "documents" | "events"> {
  const affaireId = toNullableInt(row.affaire_id, "quality_control.affaire_id");
  const ofId = row.of_id ? toInt(row.of_id, "quality_control.of_id") : null;

  return {
    id: row.id,
    control_type: row.control_type,
    status: row.status,
    result: row.result,
    control_date: row.control_date,
    comments: row.comments,

    affaire:
      affaireId !== null && row.affaire_reference
        ? {
            id: affaireId,
            reference: row.affaire_reference,
            client_id: row.affaire_client_id,
            client_company_name: row.affaire_client_company_name,
          }
        : null,
    of:
      ofId !== null && row.of_numero
        ? {
            id: ofId,
            numero: row.of_numero,
            client_id: row.of_client_id,
            client_company_name: row.of_client_company_name,
            affaire_id: toNullableInt(row.of_affaire_id, "ordres_fabrication.affaire_id"),
          }
        : null,
    piece_technique:
      row.piece_technique_id && row.piece_code_piece && row.piece_designation
        ? {
            id: row.piece_technique_id,
            code_piece: row.piece_code_piece,
            designation: row.piece_designation,
          }
        : null,
    operation:
      row.operation_id && typeof row.operation_phase === "number" && row.operation_designation
        ? {
            id: row.operation_id,
            phase: row.operation_phase,
            designation: row.operation_designation,
          }
        : null,
    machine:
      row.machine_id && row.machine_code && row.machine_name
        ? {
            id: row.machine_id,
            code: row.machine_code,
            name: row.machine_name,
          }
        : null,
    poste:
      row.poste_id && row.poste_code && row.poste_label
        ? {
            id: row.poste_id,
            code: row.poste_code,
            label: row.poste_label,
          }
        : null,

    controlled_by: mapUserLite({
      id: row.controlled_by_id,
      username: row.controlled_by_username,
      name: row.controlled_by_name,
      surname: row.controlled_by_surname,
    }),
    validated_by:
      row.validated_by_id && row.validated_by_username
        ? mapUserLite({
            id: row.validated_by_id,
            username: row.validated_by_username,
            name: row.validated_by_name,
            surname: row.validated_by_surname,
          })
        : null,
    validation_date: row.validation_date,

    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: mapUserLite({
      id: row.created_by_id,
      username: row.created_by_username,
      name: row.created_by_name,
      surname: row.created_by_surname,
    }),
    updated_by: mapUserLite({
      id: row.updated_by_id,
      username: row.updated_by_username,
      name: row.updated_by_name,
      surname: row.updated_by_surname,
    }),
  };
}

async function selectControlCore(q: DbQueryer, id: string): Promise<Omit<QualityControlDetail, "points" | "documents" | "events"> | null> {
  const res = await q.query<ControlCoreRow>(
    `
      SELECT
        qc.id::text AS id,
        qc.control_type::text AS control_type,
        qc.status::text AS status,
        qc.result::text AS result,
        qc.control_date::text AS control_date,
        qc.comments,
        qc.validation_date::text AS validation_date,
        qc.created_at::text AS created_at,
        qc.updated_at::text AS updated_at,

        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,

        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname,

        cu.id AS controlled_by_id,
        cu.username AS controlled_by_username,
        cu.name AS controlled_by_name,
        cu.surname AS controlled_by_surname,

        vu.id AS validated_by_id,
        vu.username AS validated_by_username,
        vu.name AS validated_by_name,
        vu.surname AS validated_by_surname,

        o.id::text AS of_id,
        o.numero AS of_numero,
        o.client_id AS of_client_id,
        oc.company_name AS of_client_company_name,
        o.affaire_id::text AS of_affaire_id,

        a.id::text AS affaire_id,
        a.reference AS affaire_reference,
        a.client_id AS affaire_client_id,
        ac.company_name AS affaire_client_company_name,

        pt.id::text AS piece_technique_id,
        pt.code_piece AS piece_code_piece,
        pt.designation AS piece_designation,

        op.id::text AS operation_id,
        op.phase::int AS operation_phase,
        op.designation AS operation_designation,

        m.id::text AS machine_id,
        m.code AS machine_code,
        m.name AS machine_name,

        po.id::text AS poste_id,
        po.code AS poste_code,
        po.label AS poste_label
      FROM quality_control qc
      LEFT JOIN ordres_fabrication o ON o.id = qc.of_id
      LEFT JOIN clients oc ON oc.client_id = o.client_id
      LEFT JOIN affaire a ON a.id = COALESCE(qc.affaire_id, o.affaire_id)
      LEFT JOIN clients ac ON ac.client_id = a.client_id
      LEFT JOIN pieces_techniques pt ON pt.id = COALESCE(qc.piece_technique_id, o.piece_technique_id)
      LEFT JOIN of_operations op ON op.id = qc.operation_id
      LEFT JOIN machines m ON m.id = qc.machine_id
      LEFT JOIN postes po ON po.id = qc.poste_id
      JOIN users cu ON cu.id = qc.controlled_by
      JOIN users cb ON cb.id = qc.created_by
      JOIN users ub ON ub.id = qc.updated_by
      LEFT JOIN users vu ON vu.id = qc.validated_by
      WHERE qc.id = $1::uuid
      LIMIT 1
    `,
    [id]
  );
  const row = res.rows[0];
  return row ? mapControlCore(row) : null;
}

async function selectControlPoints(q: DbQueryer, id: string): Promise<QualityControlPoint[]> {
  type Row = {
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

  const res = await q.query<Row>(
    `
      SELECT
        id::text AS id,
        quality_control_id::text AS quality_control_id,
        characteristic,
        nominal_value::float8 AS nominal_value,
        tolerance_min::float8 AS tolerance_min,
        tolerance_max::float8 AS tolerance_max,
        measured_value::float8 AS measured_value,
        unit,
        result::text AS result,
        comment,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM quality_control_points
      WHERE quality_control_id = $1::uuid
      ORDER BY created_at ASC, id ASC
    `,
    [id]
  );

  return res.rows.map((r) => ({
    id: r.id,
    quality_control_id: r.quality_control_id,
    characteristic: r.characteristic,
    nominal_value: r.nominal_value === null ? null : Number(r.nominal_value),
    tolerance_min: r.tolerance_min === null ? null : Number(r.tolerance_min),
    tolerance_max: r.tolerance_max === null ? null : Number(r.tolerance_max),
    measured_value: r.measured_value === null ? null : Number(r.measured_value),
    unit: r.unit,
    result: r.result,
    comment: r.comment,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

async function selectDocuments(q: DbQueryer, entityType: QualityEntityType, entityId: string): Promise<QualityDocument[]> {
  type Row = {
    id: string;
    entity_type: QualityEntityType;
    entity_id: string;
    document_type: QualityDocument["document_type"];
    version: number;
    original_name: string;
    stored_name: string;
    storage_path: string;
    mime_type: string;
    size_bytes: string;
    sha256: string | null;
    label: string | null;
    created_at: string;
    updated_at: string;
    uploaded_by: number | null;
    removed_at: string | null;
    removed_by: number | null;
  };

  const res = await q.query<Row>(
    `
      SELECT
        id::text AS id,
        entity_type::text AS entity_type,
        entity_id::text AS entity_id,
        document_type::text AS document_type,
        version::int AS version,
        original_name,
        stored_name,
        storage_path,
        mime_type,
        size_bytes::text AS size_bytes,
        sha256,
        label,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        uploaded_by,
        removed_at::text AS removed_at,
        removed_by
      FROM quality_documents
      WHERE entity_type = $1::quality_entity_type
        AND entity_id = $2::uuid
        AND removed_at IS NULL
      ORDER BY created_at DESC, id DESC
    `,
    [entityType, entityId]
  );

  return res.rows.map((r) => ({
    id: r.id,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    document_type: r.document_type,
    version: r.version,
    original_name: r.original_name,
    stored_name: r.stored_name,
    storage_path: r.storage_path,
    mime_type: r.mime_type,
    size_bytes: Number(r.size_bytes),
    sha256: r.sha256,
    label: r.label,
    created_at: r.created_at,
    updated_at: r.updated_at,
    uploaded_by: r.uploaded_by,
    removed_at: r.removed_at,
    removed_by: r.removed_by,
  }));
}

async function selectEvents(q: DbQueryer, entityType: QualityEntityType, entityId: string): Promise<QualityEventLog[]> {
  type Row = {
    id: number;
    entity_type: QualityEntityType;
    entity_id: string;
    event_type: string;
    old_values: unknown | null;
    new_values: unknown | null;
    user_id: number;
    username: string;
    name: string | null;
    surname: string | null;
    created_at: string;
  };

  const res = await q.query<Row>(
    `
      SELECT
        e.id::int AS id,
        e.entity_type::text AS entity_type,
        e.entity_id::text AS entity_id,
        e.event_type,
        e.old_values,
        e.new_values,
        u.id AS user_id,
        u.username,
        u.name,
        u.surname,
        e.created_at::text AS created_at
      FROM quality_event_log e
      JOIN users u ON u.id = e.user_id
      WHERE e.entity_type = $1::quality_entity_type
        AND e.entity_id = $2::uuid
      ORDER BY e.created_at ASC, e.id ASC
    `,
    [entityType, entityId]
  );

  return res.rows.map((r) => ({
    id: r.id,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    event_type: r.event_type,
    old_values: r.old_values,
    new_values: r.new_values,
    user: mapUserLite({ id: r.user_id, username: r.username, name: r.name, surname: r.surname }),
    created_at: r.created_at,
  }));
}

type ControlSnapshot = {
  control: {
    id: string;
    affaire_id: number | null;
    of_id: number | null;
    piece_technique_id: string | null;
    operation_id: string | null;
    machine_id: string | null;
    poste_id: string | null;
    control_type: string;
    status: string;
    result: string | null;
    control_date: string;
    comments: string | null;
    controlled_by: number;
    validated_by: number | null;
    validation_date: string | null;
    updated_by: number;
    updated_at: string;
  };
  points: Array<{
    characteristic: string;
    nominal_value: number | null;
    tolerance_min: number | null;
    tolerance_max: number | null;
    measured_value: number | null;
    unit: string | null;
    result: string | null;
    comment: string | null;
  }>;
};

async function selectControlSnapshot(q: DbQueryer, id: string): Promise<ControlSnapshot | null> {
  type Row = {
    id: string;
    affaire_id: string | null;
    of_id: string | null;
    piece_technique_id: string | null;
    operation_id: string | null;
    machine_id: string | null;
    poste_id: string | null;
    control_type: string;
    status: string;
    result: string | null;
    control_date: string;
    comments: string | null;
    controlled_by: number;
    validated_by: number | null;
    validation_date: string | null;
    updated_by: number;
    updated_at: string;
  };

  const coreRes = await q.query<Row>(
    `
      SELECT
        id::text AS id,
        affaire_id::text AS affaire_id,
        of_id::text AS of_id,
        piece_technique_id::text AS piece_technique_id,
        operation_id::text AS operation_id,
        machine_id::text AS machine_id,
        poste_id::text AS poste_id,
        control_type::text AS control_type,
        status::text AS status,
        result::text AS result,
        control_date::text AS control_date,
        comments,
        controlled_by,
        validated_by,
        validation_date::text AS validation_date,
        updated_by,
        updated_at::text AS updated_at
      FROM quality_control
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [id]
  );
  const r = coreRes.rows[0];
  if (!r) return null;

  const points = await q.query<{
    characteristic: string;
    nominal_value: number | null;
    tolerance_min: number | null;
    tolerance_max: number | null;
    measured_value: number | null;
    unit: string | null;
    result: string | null;
    comment: string | null;
  }>(
    `
      SELECT
        characteristic,
        nominal_value::float8 AS nominal_value,
        tolerance_min::float8 AS tolerance_min,
        tolerance_max::float8 AS tolerance_max,
        measured_value::float8 AS measured_value,
        unit,
        result::text AS result,
        comment
      FROM quality_control_points
      WHERE quality_control_id = $1::uuid
      ORDER BY created_at ASC, id ASC
    `,
    [id]
  );

  return {
    control: {
      id: r.id,
      affaire_id: toNullableInt(r.affaire_id, "quality_control.affaire_id"),
      of_id: toNullableInt(r.of_id, "quality_control.of_id"),
      piece_technique_id: r.piece_technique_id,
      operation_id: r.operation_id,
      machine_id: r.machine_id,
      poste_id: r.poste_id,
      control_type: r.control_type,
      status: r.status,
      result: r.result,
      control_date: r.control_date,
      comments: r.comments,
      controlled_by: r.controlled_by,
      validated_by: r.validated_by,
      validation_date: r.validation_date,
      updated_by: r.updated_by,
      updated_at: r.updated_at,
    },
    points: points.rows.map((p) => ({
      characteristic: p.characteristic,
      nominal_value: p.nominal_value === null ? null : Number(p.nominal_value),
      tolerance_min: p.tolerance_min === null ? null : Number(p.tolerance_min),
      tolerance_max: p.tolerance_max === null ? null : Number(p.tolerance_max),
      measured_value: p.measured_value === null ? null : Number(p.measured_value),
      unit: p.unit,
      result: p.result,
      comment: p.comment,
    })),
  };
}

function controlSortColumn(sortBy: ListControlsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "status":
      return "qc.status";
    case "updated_at":
      return "qc.updated_at";
    case "control_date":
    default:
      return "qc.control_date";
  }
}

function sortDir(dir: "asc" | "desc"): "ASC" | "DESC" {
  return dir === "asc" ? "ASC" : "DESC";
}

export async function repoListControls(filters: ListControlsQueryDTO): Promise<Paginated<QualityControlListItem>> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.date_from) where.push(`qc.control_date >= ${push(filters.date_from)}::date`);
  if (filters.date_to) where.push(`qc.control_date < (${push(filters.date_to)}::date + interval '1 day')`);
  if (filters.status) where.push(`qc.status = ${push(filters.status)}::quality_control_status`);
  if (filters.control_type) where.push(`qc.control_type = ${push(filters.control_type)}::quality_control_type`);
  if (filters.result) where.push(`qc.result = ${push(filters.result)}::quality_control_result`);
  if (typeof filters.affaire_id === "number") where.push(`qc.affaire_id = ${push(filters.affaire_id)}::bigint`);
  if (typeof filters.of_id === "number") where.push(`qc.of_id = ${push(filters.of_id)}::bigint`);
  if (filters.piece_technique_id) where.push(`qc.piece_technique_id = ${push(filters.piece_technique_id)}::uuid`);
  if (filters.machine_id) where.push(`qc.machine_id = ${push(filters.machine_id)}::uuid`);
  if (filters.poste_id) where.push(`qc.poste_id = ${push(filters.poste_id)}::uuid`);
  if (typeof filters.controlled_by === "number") where.push(`qc.controlled_by = ${push(filters.controlled_by)}`);

  if (filters.q && filters.q.trim().length > 0) {
    const q = `%${filters.q.trim()}%`;
    const p = push(q);
    where.push(`(
      COALESCE(o.numero,'') ILIKE ${p}
      OR COALESCE(a.reference,'') ILIKE ${p}
      OR COALESCE(pt.code_piece,'') ILIKE ${p}
      OR COALESCE(pt.designation,'') ILIKE ${p}
      OR COALESCE(op.designation,'') ILIKE ${p}
      OR COALESCE(m.code,'') ILIKE ${p}
      OR COALESCE(m.name,'') ILIKE ${p}
      OR COALESCE(po.code,'') ILIKE ${p}
      OR COALESCE(po.label,'') ILIKE ${p}
      OR COALESCE(qc.comments,'') ILIKE ${p}
      OR COALESCE(cu.username,'') ILIKE ${p}
      OR COALESCE(cu.name,'') ILIKE ${p}
      OR COALESCE(cu.surname,'') ILIKE ${p}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const countRes = await pool.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM quality_control qc
      LEFT JOIN ordres_fabrication o ON o.id = qc.of_id
      LEFT JOIN affaire a ON a.id = COALESCE(qc.affaire_id, o.affaire_id)
      LEFT JOIN pieces_techniques pt ON pt.id = COALESCE(qc.piece_technique_id, o.piece_technique_id)
      LEFT JOIN of_operations op ON op.id = qc.operation_id
      LEFT JOIN machines m ON m.id = qc.machine_id
      LEFT JOIN postes po ON po.id = qc.poste_id
      JOIN users cu ON cu.id = qc.controlled_by
      ${whereSql}
    `,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const orderBy = controlSortColumn(filters.sortBy);
  const orderDir = sortDir(filters.sortDir);

  const dataRes = await pool.query<ControlCoreRow>(
    `
      SELECT
        qc.id::text AS id,
        qc.control_type::text AS control_type,
        qc.status::text AS status,
        qc.result::text AS result,
        qc.control_date::text AS control_date,
        qc.comments,
        qc.validation_date::text AS validation_date,
        qc.created_at::text AS created_at,
        qc.updated_at::text AS updated_at,

        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,

        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname,

        cu.id AS controlled_by_id,
        cu.username AS controlled_by_username,
        cu.name AS controlled_by_name,
        cu.surname AS controlled_by_surname,

        vu.id AS validated_by_id,
        vu.username AS validated_by_username,
        vu.name AS validated_by_name,
        vu.surname AS validated_by_surname,

        o.id::text AS of_id,
        o.numero AS of_numero,
        o.client_id AS of_client_id,
        oc.company_name AS of_client_company_name,
        o.affaire_id::text AS of_affaire_id,

        a.id::text AS affaire_id,
        a.reference AS affaire_reference,
        a.client_id AS affaire_client_id,
        ac.company_name AS affaire_client_company_name,

        pt.id::text AS piece_technique_id,
        pt.code_piece AS piece_code_piece,
        pt.designation AS piece_designation,

        op.id::text AS operation_id,
        op.phase::int AS operation_phase,
        op.designation AS operation_designation,

        m.id::text AS machine_id,
        m.code AS machine_code,
        m.name AS machine_name,

        po.id::text AS poste_id,
        po.code AS poste_code,
        po.label AS poste_label
      FROM quality_control qc
      LEFT JOIN ordres_fabrication o ON o.id = qc.of_id
      LEFT JOIN clients oc ON oc.client_id = o.client_id
      LEFT JOIN affaire a ON a.id = COALESCE(qc.affaire_id, o.affaire_id)
      LEFT JOIN clients ac ON ac.client_id = a.client_id
      LEFT JOIN pieces_techniques pt ON pt.id = COALESCE(qc.piece_technique_id, o.piece_technique_id)
      LEFT JOIN of_operations op ON op.id = qc.operation_id
      LEFT JOIN machines m ON m.id = qc.machine_id
      LEFT JOIN postes po ON po.id = qc.poste_id
      JOIN users cu ON cu.id = qc.controlled_by
      JOIN users cb ON cb.id = qc.created_by
      JOIN users ub ON ub.id = qc.updated_by
      LEFT JOIN users vu ON vu.id = qc.validated_by
      ${whereSql}
      ORDER BY ${orderBy} ${orderDir}, qc.id ${orderDir}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  );

  const items: QualityControlListItem[] = dataRes.rows.map((r) => {
    const core = mapControlCore(r);
    return {
      id: core.id,
      control_type: core.control_type,
      status: core.status,
      result: core.result,
      control_date: core.control_date,
      comments: core.comments,
      affaire: core.affaire,
      of: core.of,
      piece_technique: core.piece_technique,
      operation: core.operation,
      machine: core.machine,
      poste: core.poste,
      controlled_by: core.controlled_by,
    };
  });

  return { items, total };
}

export async function repoGetControl(id: string): Promise<QualityControlDetail | null> {
  const core = await selectControlCore(pool, id);
  if (!core) return null;
  const points = await selectControlPoints(pool, id);
  const documents = await selectDocuments(pool, "CONTROL", id);
  const events = await selectEvents(pool, "CONTROL", id);
  return { ...core, points, documents, events };
}

async function ensureOperationBelongsToOf(q: DbQueryer, operationId: string, ofId: number) {
  const res = await q.query<{ ok: number }>(
    `SELECT 1::int AS ok FROM of_operations WHERE id = $1::uuid AND of_id = $2::bigint`,
    [operationId, ofId]
  );
  if (!res.rows[0]?.ok) {
    throw new HttpError(400, "INVALID_OPERATION", "Operation does not belong to the provided OF");
  }
}

async function replaceControlPoints(
  tx: DbQueryer,
  controlId: string,
  points: CreateControlBodyDTO["points"]
): Promise<{ inserted: QualityControlPoint[]; result: QualityControlResult }> {
  await tx.query(`DELETE FROM quality_control_points WHERE quality_control_id = $1::uuid`, [controlId]);

  if (!points.length) {
    return { inserted: [], result: "PARTIAL" };
  }

  const inserted: QualityControlPoint[] = [];
  for (const p of points) {
    const nominal = p.nominal_value ?? null;
    const tmin = p.tolerance_min ?? null;
    const tmax = p.tolerance_max ?? null;
    const measured = p.measured_value ?? null;
    const resVal = computePointResult({ nominal_value: nominal, tolerance_min: tmin, tolerance_max: tmax, measured_value: measured });

    const ins = await tx.query<{
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
    }>(
      `
        INSERT INTO quality_control_points (
          quality_control_id,
          characteristic,
          nominal_value,
          tolerance_min,
          tolerance_max,
          measured_value,
          unit,
          result,
          comment
        )
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::quality_point_result,$9)
        RETURNING
          id::text AS id,
          quality_control_id::text AS quality_control_id,
          characteristic,
          nominal_value::float8 AS nominal_value,
          tolerance_min::float8 AS tolerance_min,
          tolerance_max::float8 AS tolerance_max,
          measured_value::float8 AS measured_value,
          unit,
          result::text AS result,
          comment,
          created_at::text AS created_at,
          updated_at::text AS updated_at
      `,
      [controlId, p.characteristic, nominal, tmin, tmax, measured, p.unit ?? null, resVal, p.comment ?? null]
    );

    const row = ins.rows[0];
    if (!row) throw new Error("Failed to insert control point");
    inserted.push({
      id: row.id,
      quality_control_id: row.quality_control_id,
      characteristic: row.characteristic,
      nominal_value: row.nominal_value === null ? null : Number(row.nominal_value),
      tolerance_min: row.tolerance_min === null ? null : Number(row.tolerance_min),
      tolerance_max: row.tolerance_max === null ? null : Number(row.tolerance_max),
      measured_value: row.measured_value === null ? null : Number(row.measured_value),
      unit: row.unit,
      result: row.result,
      comment: row.comment,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  const overall = computeControlResult(inserted);
  return { inserted, result: overall };
}

export async function repoCreateControl(params: { body: CreateControlBodyDTO; audit: AuditContext }): Promise<QualityControlDetail> {
  const { body, audit } = params;

  const hasContext = Boolean(body.affaire_id || body.of_id || body.piece_technique_id);
  if (!hasContext) {
    throw new HttpError(400, "MISSING_CONTEXT", "Control must be linked to an affaire, an OF or a piece technique");
  }
  if (body.operation_id && !body.of_id) {
    throw new HttpError(400, "MISSING_OF", "operation_id requires of_id");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (body.operation_id && body.of_id) {
      await ensureOperationBelongsToOf(client, body.operation_id, body.of_id);
    }

    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO quality_control (
          affaire_id,
          of_id,
          piece_technique_id,
          operation_id,
          machine_id,
          poste_id,
          control_type,
          status,
          result,
          control_date,
          controlled_by,
          comments,
          created_by,
          updated_by
        )
        VALUES ($1::bigint,$2::bigint,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::quality_control_type,$8::quality_control_status,$9::quality_control_result,$10::timestamptz,$11,$12,$13,$14)
        RETURNING id::text AS id
      `,
      [
        body.affaire_id ?? null,
        body.of_id ?? null,
        body.piece_technique_id ?? null,
        body.operation_id ?? null,
        body.machine_id ?? null,
        body.poste_id ?? null,
        body.control_type,
        "PLANNED",
        null,
        body.control_date ?? new Date().toISOString(),
        audit.user_id,
        body.comments ?? null,
        audit.user_id,
        audit.user_id,
      ]
    );

    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to create quality control");

    const { inserted: points, result } = await replaceControlPoints(client, id, body.points ?? []);

    await client.query(`UPDATE quality_control SET result = $2::quality_control_result, updated_by = $3 WHERE id = $1::uuid`, [
      id,
      result,
      audit.user_id,
    ]);

    const snapshot = await selectControlSnapshot(client, id);
    await insertQualityEvent(client, {
      entity_type: "CONTROL",
      entity_id: id,
      event_type: "CREATE",
      user_id: audit.user_id,
      old_values: null,
      new_values: snapshot ? (snapshot as unknown as Record<string, unknown>) : { id },
    });

    await insertAuditLog(client, audit, {
      action: "qualite.controls.create",
      entity_type: "quality_control",
      entity_id: id,
      details: { points_count: points.length, result },
    });

    await client.query("COMMIT");
    const detail = await repoGetControl(id);
    if (!detail) throw new Error("Failed to reload quality control");
    return detail;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoPatchControl(params: { id: string; body: PatchControlBodyDTO; audit: AuditContext }): Promise<QualityControlDetail | null> {
  const { id, body, audit } = params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await selectControlSnapshot(client, id);
    if (!before) {
      await client.query("ROLLBACK");
      return null;
    }
    if (before.control.validation_date) {
      throw new HttpError(400, "LOCKED", "Validated controls cannot be edited");
    }

    const patch = body.patch;
    const nextOfId = typeof patch.of_id === "number" ? patch.of_id : before.control.of_id;
    const nextOperationId = patch.operation_id !== undefined ? patch.operation_id : before.control.operation_id;
    if (nextOperationId && !nextOfId) {
      throw new HttpError(400, "MISSING_OF", "operation_id requires of_id");
    }
    if (nextOperationId && nextOfId) {
      await ensureOperationBelongsToOf(client, nextOperationId, nextOfId);
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (patch.affaire_id !== undefined) fields.push(`affaire_id = ${push(patch.affaire_id)}::bigint`);
    if (patch.of_id !== undefined) fields.push(`of_id = ${push(patch.of_id)}::bigint`);
    if (patch.piece_technique_id !== undefined) fields.push(`piece_technique_id = ${push(patch.piece_technique_id)}::uuid`);
    if (patch.operation_id !== undefined) fields.push(`operation_id = ${push(patch.operation_id)}::uuid`);
    if (patch.machine_id !== undefined) fields.push(`machine_id = ${push(patch.machine_id)}::uuid`);
    if (patch.poste_id !== undefined) fields.push(`poste_id = ${push(patch.poste_id)}::uuid`);
    if (patch.control_type !== undefined) fields.push(`control_type = ${push(patch.control_type)}::quality_control_type`);
    if (patch.status !== undefined) fields.push(`status = ${push(patch.status)}::quality_control_status`);
    if (patch.control_date !== undefined) fields.push(`control_date = ${push(patch.control_date)}::timestamptz`);
    if (patch.comments !== undefined) fields.push(`comments = ${push(patch.comments)}`);

    if (fields.length) {
      fields.push(`updated_by = ${push(audit.user_id)}`);
      await client.query(`UPDATE quality_control SET ${fields.join(", ")} WHERE id = $${values.length + 1}::uuid`, [
        ...values,
        id,
      ]);
    }

    if (patch.points !== undefined) {
      const { result } = await replaceControlPoints(client, id, patch.points);
      await client.query(`UPDATE quality_control SET result = $2::quality_control_result, updated_by = $3 WHERE id = $1::uuid`, [
        id,
        result,
        audit.user_id,
      ]);
    }

    const after = await selectControlSnapshot(client, id);

    await insertQualityEvent(client, {
      entity_type: "CONTROL",
      entity_id: id,
      event_type: "UPDATE",
      user_id: audit.user_id,
      old_values: before as unknown as Record<string, unknown>,
      new_values: after ? (after as unknown as Record<string, unknown>) : null,
    });

    await insertAuditLog(client, audit, {
      action: "qualite.controls.update",
      entity_type: "quality_control",
      entity_id: id,
      details: { note: body.note ?? null },
    });

    await client.query("COMMIT");
    return repoGetControl(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoValidateControl(params: { id: string; body: ValidateControlBodyDTO; audit: AuditContext }): Promise<QualityControlDetail | null> {
  const { id, body, audit } = params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await selectControlSnapshot(client, id);
    if (!before) {
      await client.query("ROLLBACK");
      return null;
    }
    if (before.control.validation_date) {
      throw new HttpError(400, "ALREADY_VALIDATED", "Control already validated");
    }

    const points = await selectControlPoints(client, id);
    const overall = computeControlResult(points);
    const nextStatus = overall === "OK" ? "VALIDATED" : "REJECTED";

    await client.query(
      `
        UPDATE quality_control
        SET
          result = $2::quality_control_result,
          status = $3::quality_control_status,
          validated_by = $4,
          validation_date = now(),
          updated_by = $4
        WHERE id = $1::uuid
      `,
      [id, overall, nextStatus, audit.user_id]
    );

    const after = await selectControlSnapshot(client, id);

    await insertQualityEvent(client, {
      entity_type: "CONTROL",
      entity_id: id,
      event_type: "VALIDATE",
      user_id: audit.user_id,
      old_values: before as unknown as Record<string, unknown>,
      new_values: after ? (after as unknown as Record<string, unknown>) : null,
    });

    await insertAuditLog(client, audit, {
      action: "qualite.controls.validate",
      entity_type: "quality_control",
      entity_id: id,
      details: { note: body.note ?? null, status: nextStatus, result: overall },
    });

    await client.query("COMMIT");
    return repoGetControl(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoKpis(_filters: KpisQueryDTO): Promise<QualityKpis> {
  const openControlsRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM quality_control WHERE status IN ('PLANNED','IN_PROGRESS')`
  );
  const rejectedControlsRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM quality_control WHERE status = 'REJECTED'`
  );
  const openNcRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM non_conformity WHERE status <> 'CLOSED'`
  );
  const overdueActionsRes = await pool.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM quality_action
      WHERE due_date IS NOT NULL
        AND due_date < CURRENT_DATE
        AND status NOT IN ('DONE','VERIFIED')
    `
  );

  return {
    kpis: {
      open_controls: openControlsRes.rows[0]?.total ?? 0,
      rejected_controls: rejectedControlsRes.rows[0]?.total ?? 0,
      open_non_conformities: openNcRes.rows[0]?.total ?? 0,
      actions_overdue: overdueActionsRes.rows[0]?.total ?? 0,
    },
  };
}

export async function repoListUsers(filters: ListUsersQueryDTO): Promise<QualityUserLite[]> {
  const q = filters.q?.trim() ?? "";
  const limit = filters.limit ?? 200;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (q.length) {
    const p = push(`%${q}%`);
    where.push(`(u.username ILIKE ${p} OR COALESCE(u.name,'') ILIKE ${p} OR COALESCE(u.surname,'') ILIKE ${p})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

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

  return res.rows.map(mapUserLite);
}

function safeDocExtension(originalName: string): string {
  const extCandidate = path.extname(originalName).toLowerCase();
  const safeExt = /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : "";
  return safeExt;
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function repoListDocuments(entityType: QualityEntityTypeDTO, entityId: string): Promise<QualityDocument[]> {
  return selectDocuments(pool, entityType, entityId);
}

export async function repoAttachDocuments(params: {
  entity_type: QualityEntityTypeDTO;
  entity_id: string;
  document_type: QualityDocumentTypeDTO;
  documents: UploadedDocument[];
  audit: AuditContext;
}): Promise<QualityDocument[]> {
  const { entity_type, entity_id, document_type, documents, audit } = params;

  const client = await pool.connect();
  const docsDirRel = path.posix.join("uploads", "docs", "qualite");
  const docsDirAbs = path.resolve(docsDirRel);

  try {
    await client.query("BEGIN");

    if (!documents.length) {
      await client.query("COMMIT");
      return [];
    }

    await fs.mkdir(docsDirAbs, { recursive: true });

    const maxRes = await client.query<{ v: number }>(
      `
        SELECT COALESCE(MAX(version), 0)::int AS v
        FROM quality_documents
        WHERE entity_type = $1::quality_entity_type
          AND entity_id = $2::uuid
          AND document_type = $3::quality_document_type
      `,
      [entity_type, entity_id, document_type]
    );
    let nextVersion = (maxRes.rows[0]?.v ?? 0) + 1;

    const inserted: QualityDocument[] = [];
    for (const doc of documents) {
      const documentId = crypto.randomUUID();
      const safeExt = safeDocExtension(doc.originalname);
      const storedName = `${documentId}${safeExt}`;
      const relPath = toPosixPath(path.join(docsDirRel, storedName));
      const absPath = path.join(docsDirAbs, storedName);
      const tempPath = path.resolve(doc.path);

      try {
        await fs.rename(tempPath, absPath);
      } catch {
        await fs.copyFile(tempPath, absPath);
        await fs.unlink(tempPath);
      }

      const hash = await sha256File(absPath);

      const ins = await client.query<{
        id: string;
        entity_type: QualityEntityType;
        entity_id: string;
        document_type: QualityDocument["document_type"];
        version: number;
        original_name: string;
        stored_name: string;
        storage_path: string;
        mime_type: string;
        size_bytes: string;
        sha256: string | null;
        label: string | null;
        created_at: string;
        updated_at: string;
        uploaded_by: number | null;
        removed_at: string | null;
        removed_by: number | null;
      }>(
        `
          INSERT INTO quality_documents (
            entity_type,
            entity_id,
            document_type,
            version,
            original_name,
            stored_name,
            storage_path,
            mime_type,
            size_bytes,
            sha256,
            label,
            uploaded_by
          )
          VALUES ($1::quality_entity_type,$2::uuid,$3::quality_document_type,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING
            id::text AS id,
            entity_type::text AS entity_type,
            entity_id::text AS entity_id,
            document_type::text AS document_type,
            version::int AS version,
            original_name,
            stored_name,
            storage_path,
            mime_type,
            size_bytes::text AS size_bytes,
            sha256,
            label,
            created_at::text AS created_at,
            updated_at::text AS updated_at,
            uploaded_by,
            removed_at::text AS removed_at,
            removed_by
        `,
        [entity_type, entity_id, document_type, nextVersion, doc.originalname, storedName, relPath, doc.mimetype, doc.size, hash, null, audit.user_id]
      );

      const row = ins.rows[0];
      if (!row) throw new Error("Failed to insert quality document");
      inserted.push({
        id: row.id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        document_type: row.document_type,
        version: row.version,
        original_name: row.original_name,
        stored_name: row.stored_name,
        storage_path: row.storage_path,
        mime_type: row.mime_type,
        size_bytes: Number(row.size_bytes),
        sha256: row.sha256,
        label: row.label,
        created_at: row.created_at,
        updated_at: row.updated_at,
        uploaded_by: row.uploaded_by,
        removed_at: row.removed_at,
        removed_by: row.removed_by,
      });
      nextVersion += 1;
    }

    await insertQualityEvent(client, {
      entity_type,
      entity_id,
      event_type: "DOCUMENT_ATTACH",
      user_id: audit.user_id,
      old_values: null,
      new_values: {
        count: inserted.length,
        documents: inserted.map((d) => ({ id: d.id, original_name: d.original_name, mime_type: d.mime_type, size_bytes: d.size_bytes })),
      },
    });

    await insertAuditLog(client, audit, {
      action: "qualite.documents.attach",
      entity_type: "quality_documents",
      entity_id,
      details: { entity_type, entity_id, document_type, count: inserted.length },
    });

    await client.query("COMMIT");
    return inserted;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoRemoveDocument(params: {
  entity_type: QualityEntityTypeDTO;
  entity_id: string;
  doc_id: string;
  audit: AuditContext;
}): Promise<boolean> {
  const { entity_type, entity_id, doc_id, audit } = params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query<{ original_name: string; storage_path: string }>(
      `
        SELECT original_name, storage_path
        FROM quality_documents
        WHERE id = $1::uuid
          AND entity_type = $2::quality_entity_type
          AND entity_id = $3::uuid
          AND removed_at IS NULL
        FOR UPDATE
      `,
      [doc_id, entity_type, entity_id]
    );
    const doc = current.rows[0] ?? null;
    if (!doc) {
      await client.query("ROLLBACK");
      return false;
    }

    const upd = await client.query(
      `
        UPDATE quality_documents
        SET removed_at = now(), removed_by = $4, updated_at = now()
        WHERE id = $1::uuid
          AND entity_type = $2::quality_entity_type
          AND entity_id = $3::uuid
          AND removed_at IS NULL
      `,
      [doc_id, entity_type, entity_id, audit.user_id]
    );

    if ((upd.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    await insertQualityEvent(client, {
      entity_type,
      entity_id,
      event_type: "DOCUMENT_REMOVE",
      user_id: audit.user_id,
      old_values: { doc_id, original_name: doc.original_name, storage_path: doc.storage_path },
      new_values: null,
    });

    await insertAuditLog(client, audit, {
      action: "qualite.documents.remove",
      entity_type: "quality_documents",
      entity_id: doc_id,
      details: { entity_type, entity_id, original_name: doc.original_name, storage_path: doc.storage_path },
    });

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoGetDocumentForDownload(params: {
  entity_type: QualityEntityTypeDTO;
  entity_id: string;
  doc_id: string;
  audit: AuditContext;
}): Promise<QualityDocument | null> {
  const { entity_type, entity_id, doc_id, audit } = params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query<{
      id: string;
      entity_type: QualityEntityType;
      entity_id: string;
      document_type: QualityDocument["document_type"];
      version: number;
      original_name: string;
      stored_name: string;
      storage_path: string;
      mime_type: string;
      size_bytes: string;
      sha256: string | null;
      label: string | null;
      created_at: string;
      updated_at: string;
      uploaded_by: number | null;
      removed_at: string | null;
      removed_by: number | null;
    }>(
      `
        SELECT
          id::text AS id,
          entity_type::text AS entity_type,
          entity_id::text AS entity_id,
          document_type::text AS document_type,
          version::int AS version,
          original_name,
          stored_name,
          storage_path,
          mime_type,
          size_bytes::text AS size_bytes,
          sha256,
          label,
          created_at::text AS created_at,
          updated_at::text AS updated_at,
          uploaded_by,
          removed_at::text AS removed_at,
          removed_by
        FROM quality_documents
        WHERE id = $1::uuid
          AND entity_type = $2::quality_entity_type
          AND entity_id = $3::uuid
          AND removed_at IS NULL
        LIMIT 1
      `,
      [doc_id, entity_type, entity_id]
    );
    const row = res.rows[0] ?? null;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    await insertAuditLog(client, audit, {
      action: "qualite.documents.download",
      entity_type: "quality_documents",
      entity_id: doc_id,
      details: { entity_type, entity_id, original_name: row.original_name },
    });

    await client.query("COMMIT");

    return {
      id: row.id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      document_type: row.document_type,
      version: row.version,
      original_name: row.original_name,
      stored_name: row.stored_name,
      storage_path: row.storage_path,
      mime_type: row.mime_type,
      size_bytes: Number(row.size_bytes),
      sha256: row.sha256,
      label: row.label,
      created_at: row.created_at,
      updated_at: row.updated_at,
      uploaded_by: row.uploaded_by,
      removed_at: row.removed_at,
      removed_by: row.removed_by,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function qualityDocumentBaseDir(): string {
  return path.resolve("uploads/docs/qualite");
}

/* -------------------------------------------------------------------------- */
/* Non-conformities                                                           */
/* -------------------------------------------------------------------------- */

function ncSortColumn(sortBy: ListNonConformitiesQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "severity":
      return "nc.severity";
    case "updated_at":
      return "nc.updated_at";
    case "detection_date":
    default:
      return "nc.detection_date";
  }
}

export async function repoListNonConformities(filters: ListNonConformitiesQueryDTO): Promise<Paginated<NonConformityListItem>> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.date_from) where.push(`nc.detection_date >= ${push(filters.date_from)}::date`);
  if (filters.date_to) where.push(`nc.detection_date < (${push(filters.date_to)}::date + interval '1 day')`);
  if (filters.status) where.push(`nc.status = ${push(filters.status)}::quality_nc_status`);
  if (filters.severity) where.push(`nc.severity = ${push(filters.severity)}::quality_nc_severity`);
  if (typeof filters.affaire_id === "number") where.push(`nc.affaire_id = ${push(filters.affaire_id)}::bigint`);
  if (typeof filters.of_id === "number") where.push(`nc.of_id = ${push(filters.of_id)}::bigint`);
  if (filters.piece_technique_id) where.push(`nc.piece_technique_id = ${push(filters.piece_technique_id)}::uuid`);
  if (filters.control_id) where.push(`nc.control_id = ${push(filters.control_id)}::uuid`);
  if (filters.client_id) where.push(`nc.client_id = ${push(filters.client_id)}`);

  if (filters.q && filters.q.trim().length > 0) {
    const q = `%${filters.q.trim()}%`;
    const p = push(q);
    where.push(`(
      nc.reference ILIKE ${p}
      OR COALESCE(nc.description,'') ILIKE ${p}
      OR COALESCE(a.reference,'') ILIKE ${p}
      OR COALESCE(o.numero,'') ILIKE ${p}
      OR COALESCE(pt.code_piece,'') ILIKE ${p}
      OR COALESCE(pt.designation,'') ILIKE ${p}
      OR COALESCE(c.company_name,'') ILIKE ${p}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const countRes = await pool.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM non_conformity nc
      LEFT JOIN ordres_fabrication o ON o.id = nc.of_id
      LEFT JOIN affaire a ON a.id = COALESCE(nc.affaire_id, o.affaire_id)
      LEFT JOIN pieces_techniques pt ON pt.id = COALESCE(nc.piece_technique_id, o.piece_technique_id)
      LEFT JOIN clients c ON c.client_id = COALESCE(nc.client_id, o.client_id, a.client_id)
      ${whereSql}
    `,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const orderBy = ncSortColumn(filters.sortBy);
  const orderDir = sortDir(filters.sortDir);

  type Row = {
    id: string;
    reference: string;
    description: string;
    severity: NonConformityListItem["severity"];
    status: NonConformityListItem["status"];
    detection_date: string;
    control_id: string | null;
    client_id: string | null;
    client_company_name: string | null;

    affaire_id: string | null;
    affaire_reference: string | null;
    affaire_client_id: string | null;
    affaire_client_company_name: string | null;

    of_id: string | null;
    of_numero: string | null;
    of_client_id: string | null;
    of_client_company_name: string | null;
    of_affaire_id: string | null;

    piece_technique_id: string | null;
    piece_code_piece: string | null;
    piece_designation: string | null;

    detected_by_id: number;
    detected_by_username: string;
    detected_by_name: string | null;
    detected_by_surname: string | null;
  };

  const dataRes = await pool.query<Row>(
    `
      SELECT
        nc.id::text AS id,
        nc.reference,
        nc.description,
        nc.severity::text AS severity,
        nc.status::text AS status,
        nc.detection_date::text AS detection_date,
        nc.control_id::text AS control_id,
        nc.client_id,
        c.company_name AS client_company_name,

        o.id::text AS of_id,
        o.numero AS of_numero,
        o.client_id AS of_client_id,
        oc.company_name AS of_client_company_name,
        o.affaire_id::text AS of_affaire_id,

        a.id::text AS affaire_id,
        a.reference AS affaire_reference,
        a.client_id AS affaire_client_id,
        ac.company_name AS affaire_client_company_name,

        pt.id::text AS piece_technique_id,
        pt.code_piece AS piece_code_piece,
        pt.designation AS piece_designation,

        u.id AS detected_by_id,
        u.username AS detected_by_username,
        u.name AS detected_by_name,
        u.surname AS detected_by_surname
      FROM non_conformity nc
      LEFT JOIN ordres_fabrication o ON o.id = nc.of_id
      LEFT JOIN clients oc ON oc.client_id = o.client_id
      LEFT JOIN affaire a ON a.id = COALESCE(nc.affaire_id, o.affaire_id)
      LEFT JOIN clients ac ON ac.client_id = a.client_id
      LEFT JOIN pieces_techniques pt ON pt.id = COALESCE(nc.piece_technique_id, o.piece_technique_id)
      LEFT JOIN clients c ON c.client_id = COALESCE(nc.client_id, o.client_id, a.client_id)
      JOIN users u ON u.id = nc.detected_by
      ${whereSql}
      ORDER BY ${orderBy} ${orderDir}, nc.id ${orderDir}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  );

  const items: NonConformityListItem[] = dataRes.rows.map((r) => {
    const affaireId = toNullableInt(r.affaire_id, "non_conformity.affaire_id");
    const ofId = r.of_id ? toInt(r.of_id, "non_conformity.of_id") : null;

    return {
      id: r.id,
      reference: r.reference,
      description: r.description,
      severity: r.severity,
      status: r.status,
      detection_date: r.detection_date,
      affaire:
        affaireId !== null && r.affaire_reference
          ? {
              id: affaireId,
              reference: r.affaire_reference,
              client_id: r.affaire_client_id,
              client_company_name: r.affaire_client_company_name,
            }
          : null,
      of:
        ofId !== null && r.of_numero
          ? {
              id: ofId,
              numero: r.of_numero,
              client_id: r.of_client_id,
              client_company_name: r.of_client_company_name,
              affaire_id: toNullableInt(r.of_affaire_id, "ordres_fabrication.affaire_id"),
            }
          : null,
      piece_technique:
        r.piece_technique_id && r.piece_code_piece && r.piece_designation
          ? { id: r.piece_technique_id, code_piece: r.piece_code_piece, designation: r.piece_designation }
          : null,
      control_id: r.control_id,
      client_id: r.client_id,
      client_company_name: r.client_company_name,
      detected_by: mapUserLite({ id: r.detected_by_id, username: r.detected_by_username, name: r.detected_by_name, surname: r.detected_by_surname }),
    };
  });

  return { items, total };
}

type NcSnapshot = {
  non_conformity: {
    id: string;
    reference: string;
    affaire_id: number | null;
    of_id: number | null;
    piece_technique_id: string | null;
    control_id: string | null;
    client_id: string | null;
    description: string;
    severity: string;
    status: string;
    detected_by: number;
    detection_date: string;
    root_cause: string | null;
    impact: string | null;
    updated_by: number;
    updated_at: string;
  };
};

async function selectNcSnapshot(q: DbQueryer, id: string): Promise<NcSnapshot | null> {
  type Row = {
    id: string;
    reference: string;
    affaire_id: string | null;
    of_id: string | null;
    piece_technique_id: string | null;
    control_id: string | null;
    client_id: string | null;
    description: string;
    severity: string;
    status: string;
    detected_by: number;
    detection_date: string;
    root_cause: string | null;
    impact: string | null;
    updated_by: number;
    updated_at: string;
  };

  const res = await q.query<Row>(
    `
      SELECT
        id::text AS id,
        reference,
        affaire_id::text AS affaire_id,
        of_id::text AS of_id,
        piece_technique_id::text AS piece_technique_id,
        control_id::text AS control_id,
        client_id,
        description,
        severity::text AS severity,
        status::text AS status,
        detected_by,
        detection_date::text AS detection_date,
        root_cause,
        impact,
        updated_by,
        updated_at::text AS updated_at
      FROM non_conformity
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [id]
  );
  const r = res.rows[0];
  if (!r) return null;

  return {
    non_conformity: {
      id: r.id,
      reference: r.reference,
      affaire_id: toNullableInt(r.affaire_id, "non_conformity.affaire_id"),
      of_id: toNullableInt(r.of_id, "non_conformity.of_id"),
      piece_technique_id: r.piece_technique_id,
      control_id: r.control_id,
      client_id: r.client_id,
      description: r.description,
      severity: r.severity,
      status: r.status,
      detected_by: r.detected_by,
      detection_date: r.detection_date,
      root_cause: r.root_cause,
      impact: r.impact,
      updated_by: r.updated_by,
      updated_at: r.updated_at,
    },
  };
}

export async function repoGetNonConformity(id: string): Promise<NonConformityDetail | null> {
  type Row = {
    id: string;
    reference: string;
    description: string;
    severity: NonConformityDetail["severity"];
    status: NonConformityDetail["status"];
    detection_date: string;
    root_cause: string | null;
    impact: string | null;
    control_id: string | null;
    client_id: string | null;
    client_company_name: string | null;
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

    detected_by_id: number;
    detected_by_username: string;
    detected_by_name: string | null;
    detected_by_surname: string | null;

    affaire_id: string | null;
    affaire_reference: string | null;
    affaire_client_id: string | null;
    affaire_client_company_name: string | null;

    of_id: string | null;
    of_numero: string | null;
    of_client_id: string | null;
    of_client_company_name: string | null;
    of_affaire_id: string | null;

    piece_technique_id: string | null;
    piece_code_piece: string | null;
    piece_designation: string | null;
  };

  const res = await pool.query<Row>(
    `
      SELECT
        nc.id::text AS id,
        nc.reference,
        nc.description,
        nc.severity::text AS severity,
        nc.status::text AS status,
        nc.detection_date::text AS detection_date,
        nc.root_cause,
        nc.impact,
        nc.control_id::text AS control_id,
        nc.client_id,
        c.company_name AS client_company_name,
        nc.created_at::text AS created_at,
        nc.updated_at::text AS updated_at,

        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,

        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname,

        du.id AS detected_by_id,
        du.username AS detected_by_username,
        du.name AS detected_by_name,
        du.surname AS detected_by_surname,

        o.id::text AS of_id,
        o.numero AS of_numero,
        o.client_id AS of_client_id,
        oc.company_name AS of_client_company_name,
        o.affaire_id::text AS of_affaire_id,

        a.id::text AS affaire_id,
        a.reference AS affaire_reference,
        a.client_id AS affaire_client_id,
        ac.company_name AS affaire_client_company_name,

        pt.id::text AS piece_technique_id,
        pt.code_piece AS piece_code_piece,
        pt.designation AS piece_designation
      FROM non_conformity nc
      LEFT JOIN ordres_fabrication o ON o.id = nc.of_id
      LEFT JOIN clients oc ON oc.client_id = o.client_id
      LEFT JOIN affaire a ON a.id = COALESCE(nc.affaire_id, o.affaire_id)
      LEFT JOIN clients ac ON ac.client_id = a.client_id
      LEFT JOIN pieces_techniques pt ON pt.id = COALESCE(nc.piece_technique_id, o.piece_technique_id)
      LEFT JOIN clients c ON c.client_id = COALESCE(nc.client_id, o.client_id, a.client_id)
      JOIN users du ON du.id = nc.detected_by
      JOIN users cb ON cb.id = nc.created_by
      JOIN users ub ON ub.id = nc.updated_by
      WHERE nc.id = $1::uuid
      LIMIT 1
    `,
    [id]
  );

  const r = res.rows[0] ?? null;
  if (!r) return null;

  const affaireId = toNullableInt(r.affaire_id, "non_conformity.affaire_id");
  const ofId = r.of_id ? toInt(r.of_id, "non_conformity.of_id") : null;

  const actionsRes = await pool.query<{
    id: string;
    action_type: QualityActionListItem["action_type"];
    description: string;
    due_date: string | null;
    status: QualityActionListItem["status"];
    verification_date: string | null;
    verification_user_id: number | null;
    verification_user_username: string | null;
    verification_user_name: string | null;
    verification_user_surname: string | null;
    responsible_id: number;
    responsible_username: string;
    responsible_name: string | null;
    responsible_surname: string | null;
  }>(
    `
      SELECT
        a.id::text AS id,
        a.action_type::text AS action_type,
        a.description,
        a.due_date::text AS due_date,
        a.status::text AS status,
        a.verification_date::text AS verification_date,

        vu.id AS verification_user_id,
        vu.username AS verification_user_username,
        vu.name AS verification_user_name,
        vu.surname AS verification_user_surname,

        ru.id AS responsible_id,
        ru.username AS responsible_username,
        ru.name AS responsible_name,
        ru.surname AS responsible_surname
      FROM quality_action a
      JOIN users ru ON ru.id = a.responsible_user_id
      LEFT JOIN users vu ON vu.id = a.verification_user_id
      WHERE a.non_conformity_id = $1::uuid
      ORDER BY a.due_date ASC NULLS LAST, a.id ASC
    `,
    [id]
  );

  const documents = await selectDocuments(pool, "NON_CONFORMITY", id);
  const events = await selectEvents(pool, "NON_CONFORMITY", id);

  const actions: QualityActionListItem[] = actionsRes.rows.map((a) => ({
    id: a.id,
    non_conformity_id: id,
    non_conformity_reference: r.reference,
    action_type: a.action_type,
    description: a.description,
    responsible: mapUserLite({ id: a.responsible_id, username: a.responsible_username, name: a.responsible_name, surname: a.responsible_surname }),
    due_date: a.due_date,
    status: a.status,
    verification_user:
      a.verification_user_id && a.verification_user_username
        ? mapUserLite({ id: a.verification_user_id, username: a.verification_user_username, name: a.verification_user_name, surname: a.verification_user_surname })
        : null,
    verification_date: a.verification_date,
  }));

  return {
    id: r.id,
    reference: r.reference,
    description: r.description,
    severity: r.severity,
    status: r.status,
    detection_date: r.detection_date,
    root_cause: r.root_cause,
    impact: r.impact,
    affaire:
      affaireId !== null && r.affaire_reference
        ? { id: affaireId, reference: r.affaire_reference, client_id: r.affaire_client_id, client_company_name: r.affaire_client_company_name }
        : null,
    of:
      ofId !== null && r.of_numero
        ? { id: ofId, numero: r.of_numero, client_id: r.of_client_id, client_company_name: r.of_client_company_name, affaire_id: toNullableInt(r.of_affaire_id, "ordres_fabrication.affaire_id") }
        : null,
    piece_technique:
      r.piece_technique_id && r.piece_code_piece && r.piece_designation
        ? { id: r.piece_technique_id, code_piece: r.piece_code_piece, designation: r.piece_designation }
        : null,
    control_id: r.control_id,
    client_id: r.client_id,
    client_company_name: r.client_company_name,
    detected_by: mapUserLite({ id: r.detected_by_id, username: r.detected_by_username, name: r.detected_by_name, surname: r.detected_by_surname }),
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: mapUserLite({ id: r.created_by_id, username: r.created_by_username, name: r.created_by_name, surname: r.created_by_surname }),
    updated_by: mapUserLite({ id: r.updated_by_id, username: r.updated_by_username, name: r.updated_by_name, surname: r.updated_by_surname }),
    actions,
    documents,
    events,
  };
}

export async function repoCreateNonConformity(params: { body: CreateNonConformityBodyDTO; audit: AuditContext }): Promise<NonConformityDetail> {
  const { body, audit } = params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO non_conformity (
          reference,
          affaire_id,
          of_id,
          piece_technique_id,
          control_id,
          client_id,
          description,
          severity,
          status,
          detected_by,
          detection_date,
          root_cause,
          impact,
          created_by,
          updated_by
        )
        VALUES (
          COALESCE($1, public.quality_generate_nc_reference()),
          $2::bigint,$3::bigint,$4::uuid,$5::uuid,$6,
          $7,$8::quality_nc_severity,$9::quality_nc_status,$10,$11::timestamptz,
          $12,$13,$14,$15
        )
        RETURNING id::text AS id
      `,
      [
        body.reference ?? null,
        body.affaire_id ?? null,
        body.of_id ?? null,
        body.piece_technique_id ?? null,
        body.control_id ?? null,
        body.client_id ?? null,
        body.description,
        body.severity ?? "MINOR",
        body.status ?? "OPEN",
        audit.user_id,
        body.detection_date ?? new Date().toISOString(),
        body.root_cause ?? null,
        body.impact ?? null,
        audit.user_id,
        audit.user_id,
      ]
    );
    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to create non conformity");

    const snapshot = await selectNcSnapshot(client, id);
    await insertQualityEvent(client, {
      entity_type: "NON_CONFORMITY",
      entity_id: id,
      event_type: "CREATE",
      user_id: audit.user_id,
      old_values: null,
      new_values: snapshot ? (snapshot as unknown as Record<string, unknown>) : { id },
    });

    await insertAuditLog(client, audit, {
      action: "qualite.non-conformities.create",
      entity_type: "non_conformity",
      entity_id: id,
      details: { reference: body.reference ?? null, severity: body.severity ?? "MINOR" },
    });

    await client.query("COMMIT");
    const out = await repoGetNonConformity(id);
    if (!out) throw new Error("Failed to reload non conformity");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoPatchNonConformity(params: { id: string; body: PatchNonConformityBodyDTO; audit: AuditContext }): Promise<NonConformityDetail | null> {
  const { id, body, audit } = params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await selectNcSnapshot(client, id);
    if (!before) {
      await client.query("ROLLBACK");
      return null;
    }

    const patch = body.patch;
    const fields: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (patch.reference !== undefined) fields.push(`reference = ${push(patch.reference)}`);
    if (patch.affaire_id !== undefined) fields.push(`affaire_id = ${push(patch.affaire_id)}::bigint`);
    if (patch.of_id !== undefined) fields.push(`of_id = ${push(patch.of_id)}::bigint`);
    if (patch.piece_technique_id !== undefined) fields.push(`piece_technique_id = ${push(patch.piece_technique_id)}::uuid`);
    if (patch.control_id !== undefined) fields.push(`control_id = ${push(patch.control_id)}::uuid`);
    if (patch.client_id !== undefined) fields.push(`client_id = ${push(patch.client_id)}`);
    if (patch.description !== undefined) fields.push(`description = ${push(patch.description)}`);
    if (patch.severity !== undefined) fields.push(`severity = ${push(patch.severity)}::quality_nc_severity`);
    if (patch.status !== undefined) fields.push(`status = ${push(patch.status)}::quality_nc_status`);
    if (patch.detection_date !== undefined) fields.push(`detection_date = ${push(patch.detection_date)}::timestamptz`);
    if (patch.root_cause !== undefined) fields.push(`root_cause = ${push(patch.root_cause)}`);
    if (patch.impact !== undefined) fields.push(`impact = ${push(patch.impact)}`);

    fields.push(`updated_by = ${push(audit.user_id)}`);

    await client.query(`UPDATE non_conformity SET ${fields.join(", ")} WHERE id = $${values.length + 1}::uuid`, [
      ...values,
      id,
    ]);

    const after = await selectNcSnapshot(client, id);

    await insertQualityEvent(client, {
      entity_type: "NON_CONFORMITY",
      entity_id: id,
      event_type: "UPDATE",
      user_id: audit.user_id,
      old_values: before as unknown as Record<string, unknown>,
      new_values: after ? (after as unknown as Record<string, unknown>) : null,
    });

    await insertAuditLog(client, audit, {
      action: "qualite.non-conformities.update",
      entity_type: "non_conformity",
      entity_id: id,
      details: { note: body.note ?? null },
    });

    await client.query("COMMIT");
    return repoGetNonConformity(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Actions (CAPA)                                                             */
/* -------------------------------------------------------------------------- */

function actionSortColumn(sortBy: ListActionsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "status":
      return "a.status";
    case "updated_at":
      return "a.updated_at";
    case "due_date":
    default:
      return "a.due_date";
  }
}

export async function repoListActions(filters: ListActionsQueryDTO): Promise<Paginated<QualityActionListItem>> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.status) where.push(`a.status = ${push(filters.status)}::quality_action_status`);
  if (filters.action_type) where.push(`a.action_type = ${push(filters.action_type)}::quality_action_type`);
  if (typeof filters.responsible_user_id === "number") where.push(`a.responsible_user_id = ${push(filters.responsible_user_id)}`);
  if (filters.due_from) where.push(`a.due_date >= ${push(filters.due_from)}::date`);
  if (filters.due_to) where.push(`a.due_date <= ${push(filters.due_to)}::date`);
  if (filters.overdue === true) {
    where.push(`a.due_date IS NOT NULL AND a.due_date < CURRENT_DATE AND a.status NOT IN ('DONE','VERIFIED')`);
  }
  if (filters.overdue === false) {
    where.push(`(a.due_date IS NULL OR a.due_date >= CURRENT_DATE OR a.status IN ('DONE','VERIFIED'))`);
  }

  if (filters.q && filters.q.trim().length > 0) {
    const q = `%${filters.q.trim()}%`;
    const p = push(q);
    where.push(`(
      COALESCE(nc.reference,'') ILIKE ${p}
      OR COALESCE(a.description,'') ILIKE ${p}
      OR COALESCE(ru.username,'') ILIKE ${p}
      OR COALESCE(ru.name,'') ILIKE ${p}
      OR COALESCE(ru.surname,'') ILIKE ${p}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const countRes = await pool.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM quality_action a
      JOIN non_conformity nc ON nc.id = a.non_conformity_id
      JOIN users ru ON ru.id = a.responsible_user_id
      ${whereSql}
    `,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const orderBy = actionSortColumn(filters.sortBy);
  const orderDir = sortDir(filters.sortDir);

  type Row = {
    id: string;
    non_conformity_id: string;
    non_conformity_reference: string;
    action_type: QualityActionListItem["action_type"];
    description: string;
    due_date: string | null;
    status: QualityActionListItem["status"];
    verification_date: string | null;
    verification_user_id: number | null;
    verification_user_username: string | null;
    verification_user_name: string | null;
    verification_user_surname: string | null;
    responsible_id: number;
    responsible_username: string;
    responsible_name: string | null;
    responsible_surname: string | null;
  };

  const dataRes = await pool.query<Row>(
    `
      SELECT
        a.id::text AS id,
        a.non_conformity_id::text AS non_conformity_id,
        nc.reference AS non_conformity_reference,
        a.action_type::text AS action_type,
        a.description,
        a.due_date::text AS due_date,
        a.status::text AS status,
        a.verification_date::text AS verification_date,

        vu.id AS verification_user_id,
        vu.username AS verification_user_username,
        vu.name AS verification_user_name,
        vu.surname AS verification_user_surname,

        ru.id AS responsible_id,
        ru.username AS responsible_username,
        ru.name AS responsible_name,
        ru.surname AS responsible_surname
      FROM quality_action a
      JOIN non_conformity nc ON nc.id = a.non_conformity_id
      JOIN users ru ON ru.id = a.responsible_user_id
      LEFT JOIN users vu ON vu.id = a.verification_user_id
      ${whereSql}
      ORDER BY ${orderBy} ${orderDir} NULLS LAST, a.id ${orderDir}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, pageSize, offset]
  );

  const items: QualityActionListItem[] = dataRes.rows.map((r) => ({
    id: r.id,
    non_conformity_id: r.non_conformity_id,
    non_conformity_reference: r.non_conformity_reference,
    action_type: r.action_type,
    description: r.description,
    responsible: mapUserLite({ id: r.responsible_id, username: r.responsible_username, name: r.responsible_name, surname: r.responsible_surname }),
    due_date: r.due_date,
    status: r.status,
    verification_user:
      r.verification_user_id && r.verification_user_username
        ? mapUserLite({ id: r.verification_user_id, username: r.verification_user_username, name: r.verification_user_name, surname: r.verification_user_surname })
        : null,
    verification_date: r.verification_date,
  }));

  return { items, total };
}

type ActionSnapshot = {
  action: {
    id: string;
    non_conformity_id: string;
    action_type: string;
    description: string;
    responsible_user_id: number;
    due_date: string | null;
    status: string;
    verification_user_id: number | null;
    verification_date: string | null;
    effectiveness_comment: string | null;
    updated_by: number;
    updated_at: string;
  };
};

async function selectActionSnapshot(q: DbQueryer, id: string): Promise<ActionSnapshot | null> {
  type Row = {
    id: string;
    non_conformity_id: string;
    action_type: string;
    description: string;
    responsible_user_id: number;
    due_date: string | null;
    status: string;
    verification_user_id: number | null;
    verification_date: string | null;
    effectiveness_comment: string | null;
    updated_by: number;
    updated_at: string;
  };

  const res = await q.query<Row>(
    `
      SELECT
        id::text AS id,
        non_conformity_id::text AS non_conformity_id,
        action_type::text AS action_type,
        description,
        responsible_user_id,
        due_date::text AS due_date,
        status::text AS status,
        verification_user_id,
        verification_date::text AS verification_date,
        effectiveness_comment,
        updated_by,
        updated_at::text AS updated_at
      FROM quality_action
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [id]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    action: {
      id: r.id,
      non_conformity_id: r.non_conformity_id,
      action_type: r.action_type,
      description: r.description,
      responsible_user_id: r.responsible_user_id,
      due_date: r.due_date,
      status: r.status,
      verification_user_id: r.verification_user_id,
      verification_date: r.verification_date,
      effectiveness_comment: r.effectiveness_comment,
      updated_by: r.updated_by,
      updated_at: r.updated_at,
    },
  };
}

export async function repoGetAction(id: string): Promise<QualityActionDetail | null> {
  type Row = {
    id: string;
    non_conformity_id: string;
    non_conformity_reference: string;
    action_type: QualityActionDetail["action_type"];
    description: string;
    due_date: string | null;
    status: QualityActionDetail["status"];
    verification_date: string | null;
    effectiveness_comment: string | null;
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
    responsible_id: number;
    responsible_username: string;
    responsible_name: string | null;
    responsible_surname: string | null;
    verification_user_id: number | null;
    verification_user_username: string | null;
    verification_user_name: string | null;
    verification_user_surname: string | null;
  };

  const res = await pool.query<Row>(
    `
      SELECT
        a.id::text AS id,
        a.non_conformity_id::text AS non_conformity_id,
        nc.reference AS non_conformity_reference,
        a.action_type::text AS action_type,
        a.description,
        a.due_date::text AS due_date,
        a.status::text AS status,
        a.verification_date::text AS verification_date,
        a.effectiveness_comment,
        a.created_at::text AS created_at,
        a.updated_at::text AS updated_at,

        cb.id AS created_by_id,
        cb.username AS created_by_username,
        cb.name AS created_by_name,
        cb.surname AS created_by_surname,

        ub.id AS updated_by_id,
        ub.username AS updated_by_username,
        ub.name AS updated_by_name,
        ub.surname AS updated_by_surname,

        ru.id AS responsible_id,
        ru.username AS responsible_username,
        ru.name AS responsible_name,
        ru.surname AS responsible_surname,

        vu.id AS verification_user_id,
        vu.username AS verification_user_username,
        vu.name AS verification_user_name,
        vu.surname AS verification_user_surname
      FROM quality_action a
      JOIN non_conformity nc ON nc.id = a.non_conformity_id
      JOIN users ru ON ru.id = a.responsible_user_id
      JOIN users cb ON cb.id = a.created_by
      JOIN users ub ON ub.id = a.updated_by
      LEFT JOIN users vu ON vu.id = a.verification_user_id
      WHERE a.id = $1::uuid
      LIMIT 1
    `,
    [id]
  );

  const r = res.rows[0] ?? null;
  if (!r) return null;

  const documents = await selectDocuments(pool, "ACTION", id);
  const events = await selectEvents(pool, "ACTION", id);

  return {
    id: r.id,
    non_conformity_id: r.non_conformity_id,
    non_conformity_reference: r.non_conformity_reference,
    action_type: r.action_type,
    description: r.description,
    responsible: mapUserLite({ id: r.responsible_id, username: r.responsible_username, name: r.responsible_name, surname: r.responsible_surname }),
    due_date: r.due_date,
    status: r.status,
    verification_user:
      r.verification_user_id && r.verification_user_username
        ? mapUserLite({ id: r.verification_user_id, username: r.verification_user_username, name: r.verification_user_name, surname: r.verification_user_surname })
        : null,
    verification_date: r.verification_date,
    effectiveness_comment: r.effectiveness_comment,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: mapUserLite({ id: r.created_by_id, username: r.created_by_username, name: r.created_by_name, surname: r.created_by_surname }),
    updated_by: mapUserLite({ id: r.updated_by_id, username: r.updated_by_username, name: r.updated_by_name, surname: r.updated_by_surname }),
    documents,
    events,
  };
}

export async function repoCreateAction(params: { body: CreateActionBodyDTO; audit: AuditContext }): Promise<QualityActionDetail> {
  const { body, audit } = params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO quality_action (
          non_conformity_id,
          action_type,
          description,
          responsible_user_id,
          due_date,
          status,
          effectiveness_comment,
          created_by,
          updated_by
        )
        VALUES ($1::uuid,$2::quality_action_type,$3,$4,$5::date,$6::quality_action_status,$7,$8,$9)
        RETURNING id::text AS id
      `,
      [
        body.non_conformity_id,
        body.action_type,
        body.description,
        body.responsible_user_id,
        body.due_date ?? null,
        body.status ?? "OPEN",
        body.effectiveness_comment ?? null,
        audit.user_id,
        audit.user_id,
      ]
    );
    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to create quality action");

    const snapshot = await selectActionSnapshot(client, id);
    await insertQualityEvent(client, {
      entity_type: "ACTION",
      entity_id: id,
      event_type: "CREATE",
      user_id: audit.user_id,
      old_values: null,
      new_values: snapshot ? (snapshot as unknown as Record<string, unknown>) : { id },
    });

    await insertAuditLog(client, audit, {
      action: "qualite.actions.create",
      entity_type: "quality_action",
      entity_id: id,
      details: { non_conformity_id: body.non_conformity_id, responsible_user_id: body.responsible_user_id },
    });

    await client.query("COMMIT");
    const out = await repoGetAction(id);
    if (!out) throw new Error("Failed to reload quality action");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoPatchAction(params: { id: string; body: PatchActionBodyDTO; audit: AuditContext }): Promise<QualityActionDetail | null> {
  const { id, body, audit } = params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await selectActionSnapshot(client, id);
    if (!before) {
      await client.query("ROLLBACK");
      return null;
    }

    const patch = body.patch;
    const fields: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (patch.action_type !== undefined) fields.push(`action_type = ${push(patch.action_type)}::quality_action_type`);
    if (patch.description !== undefined) fields.push(`description = ${push(patch.description)}`);
    if (patch.responsible_user_id !== undefined) fields.push(`responsible_user_id = ${push(patch.responsible_user_id)}`);
    if (patch.due_date !== undefined) fields.push(`due_date = ${push(patch.due_date)}::date`);
    if (patch.status !== undefined) fields.push(`status = ${push(patch.status)}::quality_action_status`);
    if (patch.verification_user_id !== undefined) fields.push(`verification_user_id = ${push(patch.verification_user_id)}`);
    if (patch.verification_date !== undefined) fields.push(`verification_date = ${push(patch.verification_date)}::timestamptz`);
    if (patch.effectiveness_comment !== undefined) fields.push(`effectiveness_comment = ${push(patch.effectiveness_comment)}`);

    fields.push(`updated_by = ${push(audit.user_id)}`);

    await client.query(`UPDATE quality_action SET ${fields.join(", ")} WHERE id = $${values.length + 1}::uuid`, [
      ...values,
      id,
    ]);

    const after = await selectActionSnapshot(client, id);

    await insertQualityEvent(client, {
      entity_type: "ACTION",
      entity_id: id,
      event_type: "UPDATE",
      user_id: audit.user_id,
      old_values: before as unknown as Record<string, unknown>,
      new_values: after ? (after as unknown as Record<string, unknown>) : null,
    });

    await insertAuditLog(client, audit, {
      action: "qualite.actions.update",
      entity_type: "quality_action",
      entity_id: id,
      details: { note: body.note ?? null },
    });

    await client.query("COMMIT");
    return repoGetAction(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
