import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type {
  Paginated,
  PlanningEventComment,
  PlanningEventDetail,
  PlanningEventDocument,
  PlanningEventListItem,
  PlanningMachineResource,
  PlanningPosteResource,
  PlanningResources,
} from "../types/planning.types";
import type {
  CreatePlanningEventBodyDTO,
  CreatePlanningEventCommentBodyDTO,
  ListPlanningEventsQueryDTO,
  ListPlanningResourcesQueryDTO,
  PatchPlanningEventBodyDTO,
} from "../validators/planning.validators";

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

function isPgExclusionViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23P01";
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

type UploadedDocument = {
  originalname: string;
  path: string;
  mimetype: string;
  size?: number;
};

async function selectPlanningEventListItemById(q: DbQueryer, id: string): Promise<PlanningEventListItem | null> {
  type Row = {
    id: string;
    kind: PlanningEventListItem["kind"];
    status: PlanningEventListItem["status"];
    priority: PlanningEventListItem["priority"];
    of_id: string | null;
    of_operation_id: string | null;
    machine_id: string | null;
    poste_id: string | null;
    title: string;
    description: string | null;
    start_ts: string;
    end_ts: string;
    allow_overlap: boolean;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
    of_numero: string | null;
    client_company_name: string | null;
    piece_code: string | null;
    piece_designation: string | null;
    operation_phase: number | null;
    operation_designation: string | null;
    machine_code: string | null;
    machine_name: string | null;
    poste_code: string | null;
    poste_label: string | null;
  };

  const res = await q.query<Row>(
    `
      SELECT
        e.id::text AS id,
        e.kind::text AS kind,
        e.status::text AS status,
        e.priority::text AS priority,
        COALESCE(e.of_id, op.of_id)::text AS of_id,
        e.of_operation_id::text AS of_operation_id,
        e.machine_id::text AS machine_id,
        e.poste_id::text AS poste_id,
        e.title,
        e.description,
        e.start_ts::text AS start_ts,
        e.end_ts::text AS end_ts,
        e.allow_overlap,
        e.created_at::text AS created_at,
        e.updated_at::text AS updated_at,
        e.archived_at::text AS archived_at,

        o.numero AS of_numero,
        c.company_name AS client_company_name,
        pt.code_piece AS piece_code,
        pt.designation AS piece_designation,
        op.phase::int AS operation_phase,
        op.designation AS operation_designation,
        m.code AS machine_code,
        m.name AS machine_name,
        p.code AS poste_code,
        p.label AS poste_label
      FROM public.planning_events e
      LEFT JOIN public.of_operations op ON op.id = e.of_operation_id
      LEFT JOIN public.ordres_fabrication o ON o.id = COALESCE(e.of_id, op.of_id)
      LEFT JOIN public.pieces_techniques pt ON pt.id = o.piece_technique_id
      LEFT JOIN public.clients c ON c.client_id = o.client_id
      LEFT JOIN public.machines m ON m.id = e.machine_id
      LEFT JOIN public.postes p ON p.id = e.poste_id
      WHERE e.id = $1::uuid
      LIMIT 1
    `,
    [id]
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    of_id: toNullableInt(row.of_id, "planning_events.of_id"),
    of_operation_id: row.of_operation_id,
    machine_id: row.machine_id,
    poste_id: row.poste_id,
    title: row.title,
    description: row.description,
    start_ts: row.start_ts,
    end_ts: row.end_ts,
    allow_overlap: row.allow_overlap,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
    of_numero: row.of_numero,
    client_company_name: row.client_company_name,
    piece_code: row.piece_code,
    piece_designation: row.piece_designation,
    operation_phase: row.operation_phase,
    operation_designation: row.operation_designation,
    machine_code: row.machine_code,
    machine_name: row.machine_name,
    poste_code: row.poste_code,
    poste_label: row.poste_label,
  };
}

async function selectPlanningEventConflicts(
  q: DbQueryer,
  params: {
    start_ts: string;
    end_ts: string;
    machine_id?: string | null;
    poste_id?: string | null;
    exclude_id?: string | null;
  }
): Promise<Array<Pick<PlanningEventListItem, "id" | "start_ts" | "end_ts" | "title" | "of_numero">>> {
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  const startP = push(params.start_ts);
  const endP = push(params.end_ts);

  const where: string[] = [
    "e.archived_at IS NULL",
    "e.allow_overlap IS NOT TRUE",
    `tstzrange(e.start_ts, e.end_ts, '[)') && tstzrange(${startP}::timestamptz, ${endP}::timestamptz, '[)')`,
  ];

  if (params.machine_id) {
    where.push(`e.machine_id = ${push(params.machine_id)}::uuid`);
  }
  if (params.poste_id) {
    where.push(`e.poste_id = ${push(params.poste_id)}::uuid`);
  }
  if (params.exclude_id) {
    where.push(`e.id <> ${push(params.exclude_id)}::uuid`);
  }

  type Row = {
    id: string;
    start_ts: string;
    end_ts: string;
    title: string;
    of_numero: string | null;
  };

  const res = await q.query<Row>(
    `
      SELECT
        e.id::text AS id,
        e.start_ts::text AS start_ts,
        e.end_ts::text AS end_ts,
        e.title,
        o.numero AS of_numero
      FROM public.planning_events e
      LEFT JOIN public.of_operations op ON op.id = e.of_operation_id
      LEFT JOIN public.ordres_fabrication o ON o.id = COALESCE(e.of_id, op.of_id)
      WHERE ${where.join(" AND ")}
      ORDER BY e.start_ts ASC, e.id ASC
      LIMIT 25
    `,
    values
  );

  return res.rows.map((r) => ({
    id: r.id,
    start_ts: r.start_ts,
    end_ts: r.end_ts,
    title: r.title,
    of_numero: r.of_numero,
  }));
}

async function selectOfOperationDefaults(q: DbQueryer, opId: string): Promise<{
  of_id: number;
  phase: number;
  designation: string;
  machine_id: string | null;
  poste_id: string | null;
} | null> {
  type Row = {
    of_id: string;
    phase: number;
    designation: string;
    machine_id: string | null;
    poste_id: string | null;
  };

  const res = await q.query<Row>(
    `
      SELECT
        op.of_id::text AS of_id,
        op.phase::int AS phase,
        op.designation,
        op.machine_id::text AS machine_id,
        op.poste_id::text AS poste_id
      FROM public.of_operations op
      WHERE op.id = $1::uuid
      LIMIT 1
    `,
    [opId]
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    of_id: toInt(row.of_id, "of_operations.of_id"),
    phase: row.phase,
    designation: row.designation,
    machine_id: row.machine_id,
    poste_id: row.poste_id,
  };
}

function deriveTitleFromOperation(op: { phase: number; designation: string } | null): string {
  if (!op) return "Planning";
  const phase = Number.isFinite(op.phase) ? op.phase : 0;
  return phase > 0 ? `P${phase} - ${op.designation}` : op.designation;
}

function resolveResource(params: {
  machine_id?: string | null;
  poste_id?: string | null;
  op?: { machine_id: string | null; poste_id: string | null } | null;
}): { machine_id: string | null; poste_id: string | null } {
  if (params.machine_id && params.poste_id) {
    throw new HttpError(400, "INVALID_RESOURCE", "Provide either machine_id or poste_id (not both)");
  }
  if (params.machine_id || params.poste_id) {
    return { machine_id: params.machine_id ?? null, poste_id: params.poste_id ?? null };
  }

  const op = params.op;
  if (!op) {
    throw new HttpError(400, "MISSING_RESOURCE", "machine_id or poste_id is required");
  }

  // Prefer poste when available (more granular), fallback to machine.
  if (op.poste_id) return { machine_id: null, poste_id: op.poste_id };
  if (op.machine_id) return { machine_id: op.machine_id, poste_id: null };

  throw new HttpError(400, "MISSING_RESOURCE", "Operation has no machine/poste assigned; choose a resource");
}

export async function repoListPlanningResources(query: ListPlanningResourcesQueryDTO): Promise<PlanningResources> {
  const machinesWhere = query.include_archived ? "" : "WHERE m.archived_at IS NULL";
  const postesWhere = query.include_archived ? "" : "WHERE p.archived_at IS NULL";

  type MachineRow = {
    id: string;
    code: string;
    name: string;
    type: string;
    status: string;
    is_available: boolean;
    archived_at: string | null;
  };

  const machinesRes = await pool.query<MachineRow>(
    `
      SELECT
        m.id::text AS id,
        m.code,
        m.name,
        m.type::text AS type,
        m.status::text AS status,
        m.is_available,
        m.archived_at::text AS archived_at
      FROM public.machines m
      ${machinesWhere}
      ORDER BY m.code ASC, m.id ASC
    `
  );

  const machines: PlanningMachineResource[] = machinesRes.rows.map((r) => ({
    resource_type: "MACHINE",
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    status: r.status,
    is_available: r.is_available,
    archived_at: r.archived_at,
  }));

  type PosteRow = {
    id: string;
    code: string;
    label: string;
    machine_id: string | null;
    machine_code: string | null;
    machine_name: string | null;
    is_active: boolean;
    archived_at: string | null;
  };

  const postesRes = await pool.query<PosteRow>(
    `
      SELECT
        p.id::text AS id,
        p.code,
        p.label,
        p.machine_id::text AS machine_id,
        m.code AS machine_code,
        m.name AS machine_name,
        p.is_active,
        p.archived_at::text AS archived_at
      FROM public.postes p
      LEFT JOIN public.machines m ON m.id = p.machine_id
      ${postesWhere}
      ORDER BY p.code ASC, p.id ASC
    `
  );

  const postes: PlanningPosteResource[] = postesRes.rows.map((r) => ({
    resource_type: "POSTE",
    id: r.id,
    code: r.code,
    label: r.label,
    machine_id: r.machine_id,
    machine_code: r.machine_code,
    machine_name: r.machine_name,
    is_active: r.is_active,
    archived_at: r.archived_at,
  }));

  return { machines, postes };
}

export async function repoListPlanningEvents(filters: ListPlanningEventsQueryDTO): Promise<Paginated<PlanningEventListItem>> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (!filters.include_archived) {
    where.push("e.archived_at IS NULL");
  }

  const fromP = push(filters.from);
  const toP = push(filters.to);
  where.push(`tstzrange(e.start_ts, e.end_ts, '[)') && tstzrange(${fromP}::timestamptz, ${toP}::timestamptz, '[)')`);

  if (filters.machine_id) where.push(`e.machine_id = ${push(filters.machine_id)}::uuid`);
  if (filters.poste_id) where.push(`e.poste_id = ${push(filters.poste_id)}::uuid`);
  if (typeof filters.of_id === "number") where.push(`COALESCE(e.of_id, op.of_id) = ${push(filters.of_id)}::bigint`);
  if (filters.of_operation_id) where.push(`e.of_operation_id = ${push(filters.of_operation_id)}::uuid`);
  if (filters.kind) where.push(`e.kind = ${push(filters.kind)}::planning_event_kind`);
  if (filters.status) where.push(`e.status = ${push(filters.status)}::planning_event_status`);
  if (filters.priority) where.push(`e.priority = ${push(filters.priority)}::planning_priority`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRes = await pool.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM public.planning_events e
      LEFT JOIN public.of_operations op ON op.id = e.of_operation_id
      ${whereSql}
    `,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  type Row = {
    id: string;
    kind: PlanningEventListItem["kind"];
    status: PlanningEventListItem["status"];
    priority: PlanningEventListItem["priority"];
    of_id: string | null;
    of_operation_id: string | null;
    machine_id: string | null;
    poste_id: string | null;
    title: string;
    description: string | null;
    start_ts: string;
    end_ts: string;
    allow_overlap: boolean;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
    of_numero: string | null;
    client_company_name: string | null;
    piece_code: string | null;
    piece_designation: string | null;
    operation_phase: number | null;
    operation_designation: string | null;
    machine_code: string | null;
    machine_name: string | null;
    poste_code: string | null;
    poste_label: string | null;
  };

  const dataRes = await pool.query<Row>(
    `
      SELECT
        e.id::text AS id,
        e.kind::text AS kind,
        e.status::text AS status,
        e.priority::text AS priority,
        COALESCE(e.of_id, op.of_id)::text AS of_id,
        e.of_operation_id::text AS of_operation_id,
        e.machine_id::text AS machine_id,
        e.poste_id::text AS poste_id,
        e.title,
        e.description,
        e.start_ts::text AS start_ts,
        e.end_ts::text AS end_ts,
        e.allow_overlap,
        e.created_at::text AS created_at,
        e.updated_at::text AS updated_at,
        e.archived_at::text AS archived_at,

        o.numero AS of_numero,
        c.company_name AS client_company_name,
        pt.code_piece AS piece_code,
        pt.designation AS piece_designation,
        op.phase::int AS operation_phase,
        op.designation AS operation_designation,
        m.code AS machine_code,
        m.name AS machine_name,
        p.code AS poste_code,
        p.label AS poste_label
      FROM public.planning_events e
      LEFT JOIN public.of_operations op ON op.id = e.of_operation_id
      LEFT JOIN public.ordres_fabrication o ON o.id = COALESCE(e.of_id, op.of_id)
      LEFT JOIN public.pieces_techniques pt ON pt.id = o.piece_technique_id
      LEFT JOIN public.clients c ON c.client_id = o.client_id
      LEFT JOIN public.machines m ON m.id = e.machine_id
      LEFT JOIN public.postes p ON p.id = e.poste_id
      ${whereSql}
      ORDER BY e.start_ts ASC, e.id ASC
    `,
    values
  );

  const items: PlanningEventListItem[] = dataRes.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    of_id: toNullableInt(row.of_id, "planning_events.of_id"),
    of_operation_id: row.of_operation_id,
    machine_id: row.machine_id,
    poste_id: row.poste_id,
    title: row.title,
    description: row.description,
    start_ts: row.start_ts,
    end_ts: row.end_ts,
    allow_overlap: row.allow_overlap,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
    of_numero: row.of_numero,
    client_company_name: row.client_company_name,
    piece_code: row.piece_code,
    piece_designation: row.piece_designation,
    operation_phase: row.operation_phase,
    operation_designation: row.operation_designation,
    machine_code: row.machine_code,
    machine_name: row.machine_name,
    poste_code: row.poste_code,
    poste_label: row.poste_label,
  }));

  return { items, total };
}

export async function repoGetPlanningEventDetail(id: string): Promise<PlanningEventDetail | null> {
  const event = await selectPlanningEventListItemById(pool, id);
  if (!event) return null;

  type CommentRow = {
    id: string;
    event_id: string;
    body: string;
    created_by: number | null;
    created_by_username: string | null;
    created_at: string;
  };

  const commentsRes = await pool.query<CommentRow>(
    `
      SELECT
        c.id::text AS id,
        c.event_id::text AS event_id,
        c.body,
        c.created_by,
        u.username AS created_by_username,
        c.created_at::text AS created_at
      FROM public.planning_event_comments c
      LEFT JOIN public.users u ON u.id = c.created_by
      WHERE c.event_id = $1::uuid
      ORDER BY c.created_at ASC, c.id ASC
    `,
    [id]
  );

  const comments: PlanningEventComment[] = commentsRes.rows.map((r) => ({
    id: r.id,
    event_id: r.event_id,
    body: r.body,
    created_by: r.created_by,
    created_by_username: r.created_by_username,
    created_at: r.created_at,
  }));

  type DocRow = {
    document_id: string;
    document_name: string;
    type: string | null;
  };

  const docsRes = await pool.query<DocRow>(
    `
      SELECT
        ped.document_id::text AS document_id,
        dc.document_name,
        dc.type
      FROM public.planning_event_documents ped
      JOIN public.documents_clients dc ON dc.id = ped.document_id
      WHERE ped.event_id = $1::uuid
      ORDER BY dc.document_name ASC, ped.document_id ASC
    `,
    [id]
  );

  const documents: PlanningEventDocument[] = docsRes.rows.map((r) => ({
    document_id: r.document_id,
    document_name: r.document_name,
    type: r.type,
  }));

  return { event, comments, documents };
}

export async function repoCreatePlanningEvent(params: {
  body: CreatePlanningEventBodyDTO;
  audit: AuditContext;
}): Promise<PlanningEventListItem> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const b = params.body;

    const op = b.of_operation_id ? await selectOfOperationDefaults(client, b.of_operation_id) : null;
    if (b.of_operation_id && !op) {
      throw new HttpError(404, "OF_OPERATION_NOT_FOUND", "OF operation not found");
    }

    const finalOfId = typeof b.of_id === "number" ? b.of_id : op?.of_id ?? null;
    if (typeof b.of_id === "number" && op && op.of_id !== b.of_id) {
      throw new HttpError(400, "OF_OPERATION_MISMATCH", "Operation does not belong to the provided OF");
    }

    const title = b.title ?? deriveTitleFromOperation(op);
    const resource = resolveResource({ machine_id: b.machine_id ?? null, poste_id: b.poste_id ?? null, op });

    if (!b.allow_overlap) {
      const conflicts = await selectPlanningEventConflicts(client, {
        start_ts: b.start_ts,
        end_ts: b.end_ts,
        machine_id: resource.machine_id,
        poste_id: resource.poste_id,
      });
      if (conflicts.length) {
        throw new HttpError(409, "PLANNING_CONFLICT", "Resource has conflicting events", {
          conflicts,
        });
      }
    }

    const eventId = crypto.randomUUID();

    await client.query(
      `
        INSERT INTO public.planning_events (
          id,
          kind,
          status,
          priority,
          of_id,
          of_operation_id,
          machine_id,
          poste_id,
          title,
          description,
          start_ts,
          end_ts,
          allow_overlap,
          created_by,
          updated_by
        )
        VALUES (
          $1,
          $2::planning_event_kind,
          $3::planning_event_status,
          $4::planning_priority,
          $5::bigint,
          $6::uuid,
          $7::uuid,
          $8::uuid,
          $9,
          $10,
          $11::timestamptz,
          $12::timestamptz,
          $13,
          $14,
          $15
        )
      `,
      [
        eventId,
        b.kind,
        b.status,
        b.priority,
        finalOfId,
        b.of_operation_id ?? null,
        resource.machine_id,
        resource.poste_id,
        title,
        b.description ?? null,
        b.start_ts,
        b.end_ts,
        b.allow_overlap,
        params.audit.user_id,
        params.audit.user_id,
      ]
    );

    await insertAuditLog(client, params.audit, {
      action: "planning.events.create",
      entity_type: "planning_events",
      entity_id: eventId,
      details: {
        kind: b.kind,
        status: b.status,
        priority: b.priority,
        of_id: finalOfId,
        of_operation_id: b.of_operation_id ?? null,
        machine_id: resource.machine_id,
        poste_id: resource.poste_id,
        start_ts: b.start_ts,
        end_ts: b.end_ts,
        allow_overlap: b.allow_overlap,
      },
    });

    await client.query("COMMIT");

    const out = await selectPlanningEventListItemById(pool, eventId);
    if (!out) throw new Error("Failed to reload created planning event");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgExclusionViolation(err)) {
      throw new HttpError(409, "PLANNING_CONFLICT", "Resource has conflicting events");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoPatchPlanningEvent(params: {
  id: string;
  patch: PatchPlanningEventBodyDTO;
  audit: AuditContext;
}): Promise<PlanningEventListItem | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const beforeRes = await client.query<{
      id: string;
      kind: PlanningEventListItem["kind"];
      status: PlanningEventListItem["status"];
      priority: PlanningEventListItem["priority"];
      of_id: string | null;
      of_operation_id: string | null;
      machine_id: string | null;
      poste_id: string | null;
      title: string;
      description: string | null;
      start_ts: string;
      end_ts: string;
      allow_overlap: boolean;
      archived_at: string | null;
      updated_at: string;
    }>(
      `
        SELECT
          id::text AS id,
          kind::text AS kind,
          status::text AS status,
          priority::text AS priority,
          of_id::text AS of_id,
          of_operation_id::text AS of_operation_id,
          machine_id::text AS machine_id,
          poste_id::text AS poste_id,
          title,
          description,
          start_ts::text AS start_ts,
          end_ts::text AS end_ts,
          allow_overlap,
          archived_at::text AS archived_at,
          updated_at::text AS updated_at
        FROM public.planning_events
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
    if (before.archived_at) {
      throw new HttpError(409, "PLANNING_EVENT_ARCHIVED", "Archived event cannot be edited");
    }

    const p = params.patch;

    const op = p.of_operation_id ? await selectOfOperationDefaults(client, p.of_operation_id) : null;
    if (p.of_operation_id && !op) {
      throw new HttpError(404, "OF_OPERATION_NOT_FOUND", "OF operation not found");
    }

    const nextOfId = p.of_id !== undefined ? p.of_id : toNullableInt(before.of_id, "planning_events.of_id");
    const nextOfOperationId = p.of_operation_id !== undefined ? p.of_operation_id : before.of_operation_id;

    if (typeof nextOfId === "number" && op && op.of_id !== nextOfId) {
      throw new HttpError(400, "OF_OPERATION_MISMATCH", "Operation does not belong to the provided OF");
    }

    const nextStart = p.start_ts !== undefined ? p.start_ts : before.start_ts;
    const nextEnd = p.end_ts !== undefined ? p.end_ts : before.end_ts;

    const resource = resolveResource({
      machine_id: p.machine_id !== undefined ? p.machine_id : before.machine_id,
      poste_id: p.poste_id !== undefined ? p.poste_id : before.poste_id,
      op,
    });

    const nextAllowOverlap = p.allow_overlap !== undefined ? p.allow_overlap : before.allow_overlap;
    if (!nextAllowOverlap) {
      const conflicts = await selectPlanningEventConflicts(client, {
        start_ts: nextStart,
        end_ts: nextEnd,
        machine_id: resource.machine_id,
        poste_id: resource.poste_id,
        exclude_id: params.id,
      });
      if (conflicts.length) {
        throw new HttpError(409, "PLANNING_CONFLICT", "Resource has conflicting events", {
          conflicts,
        });
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    const idP = push(params.id);
    let whereSql = `id = ${idP}::uuid`;
    if (p.expected_updated_at) {
      whereSql += ` AND updated_at = ${push(p.expected_updated_at)}::timestamptz`;
    }

    if (p.kind !== undefined) sets.push(`kind = ${push(p.kind)}::planning_event_kind`);
    if (p.status !== undefined) sets.push(`status = ${push(p.status)}::planning_event_status`);
    if (p.priority !== undefined) sets.push(`priority = ${push(p.priority)}::planning_priority`);
    if (p.of_id !== undefined) sets.push(`of_id = ${push(nextOfId)}::bigint`);
    if (p.of_operation_id !== undefined) sets.push(`of_operation_id = ${push(nextOfOperationId)}::uuid`);
    if (p.machine_id !== undefined || p.poste_id !== undefined) {
      sets.push(`machine_id = ${push(resource.machine_id)}::uuid`);
      sets.push(`poste_id = ${push(resource.poste_id)}::uuid`);
    }
    if (p.title !== undefined) sets.push(`title = ${push(p.title)}`);
    if (p.description !== undefined) sets.push(`description = ${push(p.description ?? null)}`);
    if (p.start_ts !== undefined) sets.push(`start_ts = ${push(nextStart)}::timestamptz`);
    if (p.end_ts !== undefined) sets.push(`end_ts = ${push(nextEnd)}::timestamptz`);
    if (p.allow_overlap !== undefined) sets.push(`allow_overlap = ${push(nextAllowOverlap)}`);

    sets.push(`updated_by = ${push(params.audit.user_id)}`);
    sets.push(`updated_at = now()`);

    const upd = await client.query<{ id: string }>(
      `
        UPDATE public.planning_events
        SET ${sets.join(", ")}
        WHERE ${whereSql}
        RETURNING id::text AS id
      `,
      values
    );

    const updated = upd.rows[0];
    if (!updated) {
      throw new HttpError(409, "PLANNING_STALE", "Event has been modified by another user");
    }

    await insertAuditLog(client, params.audit, {
      action: "planning.events.update",
      entity_type: "planning_events",
      entity_id: params.id,
      details: {
        patch: p,
        next: {
          of_id: nextOfId,
          of_operation_id: nextOfOperationId,
          machine_id: resource.machine_id,
          poste_id: resource.poste_id,
          start_ts: nextStart,
          end_ts: nextEnd,
          allow_overlap: nextAllowOverlap,
        },
      },
    });

    await client.query("COMMIT");

    const out = await selectPlanningEventListItemById(pool, params.id);
    if (!out) throw new Error("Failed to reload patched planning event");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgExclusionViolation(err)) {
      throw new HttpError(409, "PLANNING_CONFLICT", "Resource has conflicting events");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoArchivePlanningEvent(params: { id: string; audit: AuditContext }): Promise<boolean | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const beforeRes = await client.query<{ id: string; archived_at: string | null }>(
      `SELECT id::text AS id, archived_at::text AS archived_at FROM public.planning_events WHERE id = $1::uuid FOR UPDATE`,
      [params.id]
    );
    const before = beforeRes.rows[0];
    if (!before) {
      await client.query("ROLLBACK");
      return null;
    }
    if (before.archived_at) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `
        UPDATE public.planning_events
        SET
          archived_at = now(),
          archived_by = $2,
          status = 'CANCELLED'::planning_event_status,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [params.id, params.audit.user_id]
    );

    await insertAuditLog(client, params.audit, {
      action: "planning.events.archive",
      entity_type: "planning_events",
      entity_id: params.id,
      details: null,
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

export async function repoCreatePlanningEventComment(params: {
  event_id: string;
  body: CreatePlanningEventCommentBodyDTO;
  audit: AuditContext;
}): Promise<PlanningEventComment> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.planning_events WHERE id = $1::uuid AND archived_at IS NULL LIMIT 1`,
      [params.event_id]
    );
    if (!exists.rows[0]) {
      throw new HttpError(404, "PLANNING_EVENT_NOT_FOUND", "Event not found");
    }

    const commentId = crypto.randomUUID();
    const ins = await client.query<{
      id: string;
      event_id: string;
      body: string;
      created_by: number | null;
      created_at: string;
      username: string | null;
    }>(
      `
        INSERT INTO public.planning_event_comments (id, event_id, body, created_by)
        VALUES ($1, $2::uuid, $3, $4)
        RETURNING
          id::text AS id,
          event_id::text AS event_id,
          body,
          created_by,
          created_at::text AS created_at,
          (SELECT u.username FROM public.users u WHERE u.id = $4) AS username
      `,
      [commentId, params.event_id, params.body.body, params.audit.user_id]
    );

    const row = ins.rows[0];
    if (!row) throw new Error("Failed to create comment");

    await insertAuditLog(client, params.audit, {
      action: "planning.events.comment.create",
      entity_type: "planning_events",
      entity_id: params.event_id,
      details: { comment_id: commentId },
    });

    await client.query("COMMIT");

    return {
      id: row.id,
      event_id: row.event_id,
      body: row.body,
      created_by: row.created_by,
      created_by_username: row.username,
      created_at: row.created_at,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function insertPlanningEventDocuments(tx: PoolClient, params: {
  event_id: string;
  documents: UploadedDocument[];
  user_id: number;
}) {
  if (!params.documents.length) return;

  for (const doc of params.documents) {
    const documentId = crypto.randomUUID();
    const isPdf = doc.originalname.toLowerCase().endsWith(".pdf") || doc.mimetype.toLowerCase().includes("pdf");
    const docType = isPdf ? "PDF" : doc.mimetype;

    const extCandidate = path.extname(doc.originalname).toLowerCase();
    const safeExt = /^\.[a-z0-9]+$/.test(extCandidate) && extCandidate.length <= 10 ? extCandidate : "";

    const uploadDir = path.resolve("uploads/docs");
    const finalPath = path.join(uploadDir, `${documentId}${safeExt}`);

    try {
      await fs.rename(doc.path, finalPath);
    } catch {
      await fs.copyFile(doc.path, finalPath);
      await fs.unlink(doc.path);
    }

    await tx.query(
      `INSERT INTO public.documents_clients (id, document_name, type) VALUES ($1, $2, $3)`,
      [documentId, doc.originalname, docType]
    );

    await tx.query(
      `
        INSERT INTO public.planning_event_documents (event_id, document_id, type, created_by)
        VALUES ($1::uuid, $2::uuid, $3, $4)
      `,
      [params.event_id, documentId, isPdf ? "PDF" : null, params.user_id]
    );
  }
}

export async function repoUploadPlanningEventDocuments(params: {
  event_id: string;
  documents: UploadedDocument[];
  audit: AuditContext;
}): Promise<PlanningEventDocument[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.planning_events WHERE id = $1::uuid AND archived_at IS NULL LIMIT 1`,
      [params.event_id]
    );
    if (!exists.rows[0]) {
      throw new HttpError(404, "PLANNING_EVENT_NOT_FOUND", "Event not found");
    }

    await insertPlanningEventDocuments(client, {
      event_id: params.event_id,
      documents: params.documents,
      user_id: params.audit.user_id,
    });

    await insertAuditLog(client, params.audit, {
      action: "planning.events.documents.upload",
      entity_type: "planning_events",
      entity_id: params.event_id,
      details: { count: params.documents.length },
    });

    await client.query("COMMIT");

    const docsRes = await pool.query<{ document_id: string; document_name: string; type: string | null }>(
      `
        SELECT
          ped.document_id::text AS document_id,
          dc.document_name,
          dc.type
        FROM public.planning_event_documents ped
        JOIN public.documents_clients dc ON dc.id = ped.document_id
        WHERE ped.event_id = $1::uuid
        ORDER BY dc.document_name ASC, ped.document_id ASC
      `,
      [params.event_id]
    );

    return docsRes.rows.map((r) => ({
      document_id: r.document_id,
      document_name: r.document_name,
      type: r.type,
    }));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoGetPlanningEventDocumentFileMeta(params: {
  event_id: string;
  document_id: string;
}): Promise<{ id: string; document_name: string; type: string | null } | null> {
  const res = await pool.query<{ id: string; document_name: string; type: string | null }>(
    `
      SELECT
        dc.id::text AS id,
        dc.document_name,
        dc.type
      FROM public.planning_event_documents ped
      JOIN public.documents_clients dc ON dc.id = ped.document_id
      WHERE ped.event_id = $1::uuid AND ped.document_id = $2::uuid
      LIMIT 1
    `,
    [params.event_id, params.document_id]
  );
  return res.rows[0] ?? null;
}
