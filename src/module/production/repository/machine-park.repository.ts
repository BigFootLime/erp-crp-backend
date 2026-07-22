import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import {
  assertDocumentUploadAllowed,
  sha256DocumentFile,
  toPosixStoragePath,
} from "../../../shared/documents/document-upload";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type { AuditContext } from "./production.repository";
import type {
  MachineMaintenanceEvent,
  MachineMaintenancePlan,
  MachineParkContext,
  MachineUnavailability,
} from "../types/machine-park.types";
import type { MachineDocument } from "../types/machine-intelligence.types";
import type {
  CreateMachineDocumentBodyDTO,
  CreateMachineMaintenanceEventBodyDTO,
  CreateMachineMaintenancePlanBodyDTO,
  CreateMachineUnavailabilityBodyDTO,
  ListMachineUnavailabilityQueryDTO,
  UpdateMachineMaintenancePlanBodyDTO,
  UploadMachineDocumentBodyDTO,
} from "../validators/machine-park.validators";

type DbQueryer = Pick<PoolClient, "query">;

export type MachineDocumentDownload = {
  storage_path: string;
  mime_type: string;
  original_name: string;
};

async function audit(tx: DbQueryer, context: AuditContext, input: {
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: input.action,
    page_key: context.page_key,
    entity_type: input.entityType,
    entity_id: input.entityId,
    path: context.path,
    client_session_id: context.client_session_id,
    details: input.details ?? null,
  };
  await repoInsertAuditLog({
    user_id: context.user_id,
    body,
    ip: context.ip,
    user_agent: context.user_agent,
    device_type: context.device_type,
    os: context.os,
    browser: context.browser,
    tx,
  });
}

function isExclusionViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "23P01";
}

async function requireActiveMachine(tx: DbQueryer, machineId: string) {
  const result = await tx.query<{ id: string; status: string; scheduling_enabled: boolean; archived_at: string | null }>(
    `SELECT id::text AS id, status::text AS status, scheduling_enabled, archived_at::text AS archived_at
       FROM public.machines WHERE id = $1::uuid FOR UPDATE`,
    [machineId]
  );
  const machine = result.rows[0];
  if (!machine) throw new HttpError(404, "MACHINE_NOT_FOUND", "Machine not found.");
  if (machine.archived_at) throw new HttpError(409, "MACHINE_ARCHIVED", "Archived machine cannot be scheduled.");
  return machine;
}

const UNAVAILABILITY_SELECT = `
  SELECT
    u.id::text AS id,
    u.machine_id::text AS machine_id,
    u.planning_event_id::text AS planning_event_id,
    u.cause,
    u.comment,
    u.source,
    u.maintenance_plan_id::text AS maintenance_plan_id,
    e.start_ts::text AS start_ts,
    e.end_ts::text AS end_ts,
    e.status::text AS status,
    u.created_at::text AS created_at,
    u.created_by,
    u.archived_at::text AS archived_at
  FROM public.production_machine_unavailability u
  JOIN public.planning_events e ON e.id = u.planning_event_id
`;

export async function repoListMachineUnavailability(machineId: string, query: ListMachineUnavailabilityQueryDTO): Promise<MachineUnavailability[]> {
  const values: unknown[] = [machineId];
  const where = ["u.machine_id = $1::uuid"];
  if (!query.include_archived) where.push("u.archived_at IS NULL", "e.archived_at IS NULL");
  if (query.from && query.to) {
    values.push(query.from, query.to);
    where.push(`tstzrange(e.start_ts, e.end_ts, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')`);
  }
  const result = await pool.query<MachineUnavailability>(
    `${UNAVAILABILITY_SELECT} WHERE ${where.join(" AND ")} ORDER BY e.start_ts ASC`,
    values
  );
  return result.rows;
}

export async function repoGetMachineParkContext(machineId: string): Promise<MachineParkContext | null> {
  const machineResult = await pool.query<{ status: string; scheduling_enabled: boolean; archived_at: string | null }>(
    `SELECT status::text AS status, scheduling_enabled, archived_at::text AS archived_at
       FROM public.machines WHERE id = $1::uuid`,
    [machineId]
  );
  const machine = machineResult.rows[0];
  if (!machine) return null;

  const [unavailabilityResult, dueResult, loadResult, ofsResult] = await Promise.all([
    pool.query<MachineUnavailability>(
      `${UNAVAILABILITY_SELECT}
       WHERE u.machine_id = $1::uuid AND u.archived_at IS NULL AND e.archived_at IS NULL
         AND e.status NOT IN ('DONE', 'CANCELLED') AND e.end_ts > now()
       ORDER BY e.start_ts ASC LIMIT 25`,
      [machineId]
    ),
    pool.query<MachineMaintenancePlan>(
      `SELECT id::text AS id, machine_id::text AS machine_id, title, status,
              frequency_days, frequency_counter::float8 AS frequency_counter, counter_unit,
              next_due_at::text AS next_due_at, responsible_user_id, checklist,
              document_id::text AS document_id, source, notes, version,
              created_at::text AS created_at, updated_at::text AS updated_at,
              archived_at::text AS archived_at
         FROM public.production_machine_maintenance_plans
        WHERE machine_id = $1::uuid AND archived_at IS NULL AND status = 'ACTIVE'
          AND next_due_at IS NOT NULL AND next_due_at <= current_date + 30
        ORDER BY next_due_at ASC`,
      [machineId]
    ),
    pool.query<{ planned_minutes: number }>(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(end_ts, now() + interval '7 days') - GREATEST(start_ts, now()))) / 60), 0)::int AS planned_minutes
         FROM public.planning_events
        WHERE machine_id = $1::uuid AND archived_at IS NULL AND status NOT IN ('CANCELLED')
          AND end_ts > now() AND start_ts < now() + interval '7 days'`,
      [machineId]
    ),
    pool.query<{ id: number; numero: string; statut: string; operation_count: number }>(
      `SELECT o.id::int AS id, o.numero, o.statut::text AS statut, count(op.id)::int AS operation_count
         FROM public.ordres_fabrication o
         JOIN public.of_operations op ON op.of_id = o.id
        WHERE op.machine_id = $1::uuid AND o.statut NOT IN ('CLOTURE', 'ANNULE')
        GROUP BY o.id, o.numero, o.statut ORDER BY o.updated_at DESC LIMIT 20`,
      [machineId]
    ),
  ]);

  const now = Date.now();
  const active = unavailabilityResult.rows.find((item) => Date.parse(item.start_ts) <= now && Date.parse(item.end_ts) > now) ?? null;
  let availableNow = true;
  let reason = "No active unavailability in the canonical planning calendar.";
  if (machine.archived_at) {
    availableNow = false;
    reason = "Machine archived.";
  } else if (machine.status !== "ACTIVE") {
    availableNow = false;
    reason = `Structural status: ${machine.status}.`;
  } else if (!machine.scheduling_enabled) {
    availableNow = false;
    reason = "Planning disabled for this machine.";
  } else if (active) {
    availableNow = false;
    reason = `Active unavailability: ${active.cause}.`;
  }

  return {
    available_now: availableNow,
    availability_reason: reason,
    active_unavailability: active,
    upcoming_unavailability: unavailabilityResult.rows.filter((item) => Date.parse(item.start_ts) > now),
    maintenance_due: dueResult.rows,
    planned_minutes_next_7d: Number(loadResult.rows[0]?.planned_minutes ?? 0),
    capacity_minutes_next_7d: null,
    capacity_reason: "Not calculated: no canonical workshop opening-hours calendar is configured.",
    linked_open_ofs: ofsResult.rows,
  };
}

export async function repoCreateMachineUnavailability(params: {
  machineId: string;
  body: CreateMachineUnavailabilityBodyDTO;
  audit: AuditContext;
}): Promise<MachineUnavailability> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireActiveMachine(client, params.machineId);
    if (params.body.maintenance_plan_id) {
      const plan = await client.query(`SELECT 1 FROM public.production_machine_maintenance_plans WHERE id = $1::uuid AND machine_id = $2::uuid AND archived_at IS NULL`, [params.body.maintenance_plan_id, params.machineId]);
      if (!plan.rowCount) throw new HttpError(422, "MAINTENANCE_PLAN_INVALID", "Maintenance plan does not belong to the machine.");
    }

    const planningEventId = crypto.randomUUID();
    await client.query(
      `INSERT INTO public.planning_events (
         id, kind, status, priority, machine_id, title, description,
         start_ts, end_ts, allow_overlap, created_by, updated_by
       ) VALUES ($1::uuid, $2::planning_event_kind, 'PLANNED', $3::planning_priority, $4::uuid, $5, $6, $7::timestamptz, $8::timestamptz, false, $9, $9)`,
      [
        planningEventId,
        params.body.cause === "PREVENTIVE_MAINTENANCE" || params.body.cause === "BREAKDOWN" ? "MAINTENANCE" : "CUSTOM",
        params.body.cause === "BREAKDOWN" ? "CRITICAL" : "NORMAL",
        params.machineId,
        `Indisponibilité machine — ${params.body.cause}`,
        params.body.comment ?? null,
        params.body.start_ts,
        params.body.end_ts,
        params.audit.user_id,
      ]
    );

    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO public.production_machine_unavailability (
         id, machine_id, planning_event_id, cause, comment, source, maintenance_plan_id, created_by, updated_by
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8, $8)`,
      [id, params.machineId, planningEventId, params.body.cause, params.body.comment ?? null, params.body.source, params.body.maintenance_plan_id ?? null, params.audit.user_id]
    );
    await audit(client, params.audit, {
      action: "production.machines.unavailability.create",
      entityType: "production_machine_unavailability",
      entityId: id,
      details: { machine_id: params.machineId, planning_event_id: planningEventId, cause: params.body.cause, start_ts: params.body.start_ts, end_ts: params.body.end_ts },
    });
    await client.query("COMMIT");
    const rows = await repoListMachineUnavailability(params.machineId, { include_archived: false });
    const created = rows.find((row) => row.id === id);
    if (!created) throw new Error("Failed to reload machine unavailability");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    if (isExclusionViolation(error)) {
      throw new HttpError(409, "MACHINE_UNAVAILABILITY_OVERLAP", "The machine already has a planning event that overlaps this period.");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function repoArchiveMachineUnavailability(params: { machineId: string; unavailabilityId: string; audit: AuditContext }): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ planning_event_id: string }>(
      `SELECT planning_event_id::text AS planning_event_id FROM public.production_machine_unavailability
        WHERE id = $1::uuid AND machine_id = $2::uuid AND archived_at IS NULL FOR UPDATE`,
      [params.unavailabilityId, params.machineId]
    );
    const existing = row.rows[0];
    if (!existing) throw new HttpError(404, "MACHINE_UNAVAILABILITY_NOT_FOUND", "Machine unavailability not found.");
    await client.query(`UPDATE public.production_machine_unavailability SET archived_at = now(), archived_by = $3, updated_at = now(), updated_by = $3 WHERE id = $1::uuid AND machine_id = $2::uuid`, [params.unavailabilityId, params.machineId, params.audit.user_id]);
    await client.query(`UPDATE public.planning_events SET status = 'CANCELLED', archived_at = now(), archived_by = $2, updated_at = now(), updated_by = $2 WHERE id = $1::uuid`, [existing.planning_event_id, params.audit.user_id]);
    await audit(client, params.audit, { action: "production.machines.unavailability.archive", entityType: "production_machine_unavailability", entityId: params.unavailabilityId, details: { machine_id: params.machineId, planning_event_id: existing.planning_event_id } });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoListMachineMaintenancePlans(machineId: string): Promise<MachineMaintenancePlan[]> {
  const result = await pool.query<MachineMaintenancePlan>(
    `SELECT id::text AS id, machine_id::text AS machine_id, title, status,
            frequency_days, frequency_counter::float8 AS frequency_counter, counter_unit,
            next_due_at::text AS next_due_at, responsible_user_id, checklist,
            document_id::text AS document_id, source, notes, version,
            created_at::text AS created_at, updated_at::text AS updated_at,
            archived_at::text AS archived_at
       FROM public.production_machine_maintenance_plans
      WHERE machine_id = $1::uuid AND archived_at IS NULL ORDER BY next_due_at NULLS LAST, title`,
    [machineId]
  );
  return result.rows;
}

export async function repoCreateMachineMaintenancePlan(params: { machineId: string; body: CreateMachineMaintenancePlanBodyDTO; audit: AuditContext }): Promise<MachineMaintenancePlan> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireActiveMachine(client, params.machineId);
    const id = crypto.randomUUID();
    const b = params.body;
    await client.query(
      `INSERT INTO public.production_machine_maintenance_plans (
         id, machine_id, title, status, frequency_days, frequency_counter, counter_unit,
         next_due_at, responsible_user_id, checklist, document_id, source, notes, created_by, updated_by
       ) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::date,$9,$10::jsonb,$11::uuid,$12,$13,$14,$14)`,
      [id, params.machineId, b.title, b.status, b.frequency_days ?? null, b.frequency_counter ?? null, b.counter_unit ?? null, b.next_due_at ?? null, b.responsible_user_id ?? null, JSON.stringify(b.checklist), b.document_id ?? null, b.source, b.notes ?? null, params.audit.user_id]
    );
    await audit(client, params.audit, { action: "production.machines.maintenance-plan.create", entityType: "production_machine_maintenance_plans", entityId: id, details: { machine_id: params.machineId, title: b.title, next_due_at: b.next_due_at } });
    await client.query("COMMIT");
    const created = (await repoListMachineMaintenancePlans(params.machineId)).find((row) => row.id === id);
    if (!created) throw new Error("Failed to reload maintenance plan");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoUpdateMachineMaintenancePlan(params: { machineId: string; planId: string; body: UpdateMachineMaintenancePlanBodyDTO; audit: AuditContext }): Promise<MachineMaintenancePlan> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query<MachineMaintenancePlan>(
      `SELECT id::text AS id, machine_id::text AS machine_id, title, status, frequency_days,
              frequency_counter::float8 AS frequency_counter, counter_unit, next_due_at::text AS next_due_at,
              responsible_user_id, checklist, document_id::text AS document_id, source, notes, version,
              created_at::text AS created_at, updated_at::text AS updated_at, archived_at::text AS archived_at
         FROM public.production_machine_maintenance_plans
        WHERE id = $1::uuid AND machine_id = $2::uuid AND archived_at IS NULL FOR UPDATE`,
      [params.planId, params.machineId]
    );
    const current = currentResult.rows[0];
    if (!current) throw new HttpError(404, "MAINTENANCE_PLAN_NOT_FOUND", "Maintenance plan not found.");
    if (current.updated_at !== params.body.expected_updated_at) throw new HttpError(409, "CONCURRENT_MODIFICATION", "Maintenance plan has changed.");
    const b = params.body;
    const next = {
      title: b.title ?? current.title,
      status: b.status ?? current.status,
      frequency_days: b.frequency_days === undefined ? current.frequency_days : b.frequency_days,
      frequency_counter: b.frequency_counter === undefined ? current.frequency_counter : b.frequency_counter,
      counter_unit: b.counter_unit === undefined ? current.counter_unit : b.counter_unit,
      next_due_at: b.next_due_at === undefined ? current.next_due_at : b.next_due_at,
      responsible_user_id: b.responsible_user_id === undefined ? current.responsible_user_id : b.responsible_user_id,
      checklist: b.checklist ?? current.checklist,
      document_id: b.document_id === undefined ? current.document_id : b.document_id,
      source: b.source ?? current.source,
      notes: b.notes === undefined ? current.notes : b.notes,
    };
    await client.query(
      `UPDATE public.production_machine_maintenance_plans SET
         title=$3,status=$4,frequency_days=$5,frequency_counter=$6,counter_unit=$7,next_due_at=$8::date,
         responsible_user_id=$9,checklist=$10::jsonb,document_id=$11::uuid,source=$12,notes=$13,
         version=version+1,updated_at=now(),updated_by=$14
       WHERE id=$1::uuid AND machine_id=$2::uuid AND updated_at::text=$15`,
      [params.planId, params.machineId, next.title, next.status, next.frequency_days, next.frequency_counter, next.counter_unit, next.next_due_at, next.responsible_user_id, JSON.stringify(next.checklist), next.document_id, next.source, next.notes, params.audit.user_id, params.body.expected_updated_at]
    );
    await audit(client, params.audit, { action: "production.machines.maintenance-plan.update", entityType: "production_machine_maintenance_plans", entityId: params.planId, details: { before: current, after: next } });
    await client.query("COMMIT");
    const updated = (await repoListMachineMaintenancePlans(params.machineId)).find((row) => row.id === params.planId);
    if (!updated) throw new Error("Failed to reload maintenance plan");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoListMachineMaintenanceEvents(machineId: string): Promise<MachineMaintenanceEvent[]> {
  const result = await pool.query<MachineMaintenanceEvent>(
    `SELECT id::text AS id, machine_id::text AS machine_id, maintenance_plan_id::text AS maintenance_plan_id,
            event_type, occurred_at::text AS occurred_at, due_at::text AS due_at,
            planning_event_id::text AS planning_event_id, unavailability_id::text AS unavailability_id,
            checklist_result, notes, created_at::text AS created_at, created_by
       FROM public.production_machine_maintenance_events
      WHERE machine_id = $1::uuid ORDER BY occurred_at DESC, created_at DESC LIMIT 500`,
    [machineId]
  );
  return result.rows;
}

export async function repoCreateMachineMaintenanceEvent(params: { machineId: string; body: CreateMachineMaintenanceEventBodyDTO; audit: AuditContext }): Promise<MachineMaintenanceEvent> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireActiveMachine(client, params.machineId);
    if (params.body.maintenance_plan_id) {
      const plan = await client.query<{ frequency_days: number | null }>(`SELECT frequency_days FROM public.production_machine_maintenance_plans WHERE id=$1::uuid AND machine_id=$2::uuid AND archived_at IS NULL FOR UPDATE`, [params.body.maintenance_plan_id, params.machineId]);
      if (!plan.rows[0]) throw new HttpError(422, "MAINTENANCE_PLAN_INVALID", "Maintenance plan does not belong to the machine.");
      if (params.body.event_type === "COMPLETED" && plan.rows[0].frequency_days) {
        await client.query(`UPDATE public.production_machine_maintenance_plans SET next_due_at=COALESCE($3::timestamptz, now())::date + frequency_days, version=version+1, updated_at=now(), updated_by=$4 WHERE id=$1::uuid AND machine_id=$2::uuid`, [params.body.maintenance_plan_id, params.machineId, params.body.occurred_at ?? null, params.audit.user_id]);
      }
    }
    const id = crypto.randomUUID();
    const b = params.body;
    await client.query(
      `INSERT INTO public.production_machine_maintenance_events (
         id,machine_id,maintenance_plan_id,event_type,occurred_at,due_at,checklist_result,notes,created_by
       ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,COALESCE($5::timestamptz,now()),$6::timestamptz,$7::jsonb,$8,$9)`,
      [id, params.machineId, b.maintenance_plan_id ?? null, b.event_type, b.occurred_at ?? null, b.due_at ?? null, JSON.stringify(b.checklist_result), b.notes ?? null, params.audit.user_id]
    );
    await audit(client, params.audit, { action: "production.machines.maintenance-event.create", entityType: "production_machine_maintenance_events", entityId: id, details: { machine_id: params.machineId, maintenance_plan_id: b.maintenance_plan_id, event_type: b.event_type } });
    await client.query("COMMIT");
    const created = (await repoListMachineMaintenanceEvents(params.machineId)).find((row) => row.id === id);
    if (!created) throw new Error("Failed to reload maintenance event");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoReactivateMachine(params: { machineId: string; expectedUpdatedAt: string; audit: AuditContext }): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE public.machines SET archived_at=NULL,archived_by=NULL,status='ACTIVE',is_available=true,updated_at=now(),updated_by=$3
        WHERE id=$1::uuid AND archived_at IS NOT NULL AND updated_at::text=$2`,
      [params.machineId, params.expectedUpdatedAt, params.audit.user_id]
    );
    if (!updated.rowCount) throw new HttpError(409, "CONCURRENT_MODIFICATION", "Machine cannot be reactivated from the supplied version.");
    await audit(client, params.audit, { action: "production.machines.reactivate", entityType: "machines", entityId: params.machineId });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoCreateMachineDocument(params: { machineId: string; body: CreateMachineDocumentBodyDTO; audit: AuditContext }): Promise<MachineDocument> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireActiveMachine(client, params.machineId);
    const id = crypto.randomUUID();
    const b = params.body;
    const result = await client.query<MachineDocument>(
      `INSERT INTO public.production_machine_documents (
         id,machine_id,title,document_type,url,revision,sha256,mime_type,size_bytes,authored_at,
         source_type,source_confidence,source_notes,retrieved_at,created_by
       ) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12,$13,now(),$14)
       RETURNING id::text AS id,machine_model_id::text AS machine_model_id,machine_id::text AS machine_id,
         title,document_type,url,revision,sha256,mime_type,size_bytes::float8 AS size_bytes,
         authored_at::text AS authored_at,source_type,source_confidence,source_notes,
         retrieved_at::text AS retrieved_at,removed_at::text AS removed_at`,
      [id, params.machineId, b.title, b.document_type, b.url, b.revision ?? null, b.sha256 ?? null, b.mime_type ?? null, b.size_bytes ?? null, b.authored_at ?? null, b.source_type, b.source_confidence, b.source_notes ?? null, params.audit.user_id]
    );
    const created = result.rows[0];
    if (!created) throw new Error("Failed to create machine document");
    await audit(client, params.audit, { action: "production.machines.document.create", entityType: "production_machine_documents", entityId: id, details: { machine_id: params.machineId, document_type: b.document_type, revision: b.revision, sha256: b.sha256 } });
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoUploadMachineDocument(params: {
  machineId: string;
  body: UploadMachineDocumentBodyDTO;
  file: Express.Multer.File;
  audit: AuditContext;
}): Promise<MachineDocument> {
  let extension: string;
  try {
    extension = await assertDocumentUploadAllowed(params.file);
  } catch (error) {
    await fs.unlink(params.file.path).catch(() => undefined);
    throw error;
  }

  const client = await pool.connect();
  const documentsDirectory = ensureDocumentStoragePath("machines");
  const id = crypto.randomUUID();
  const finalPath = path.join(documentsDirectory, `${id}${extension}`);
  let moved = false;
  try {
    await client.query("BEGIN");
    await requireActiveMachine(client, params.machineId);
    try {
      await fs.rename(path.resolve(params.file.path), finalPath);
    } catch {
      await fs.copyFile(path.resolve(params.file.path), finalPath);
      await fs.unlink(path.resolve(params.file.path));
    }
    moved = true;
    const sha256 = await sha256DocumentFile(finalPath);
    const b = params.body;
    const result = await client.query<MachineDocument>(
      `INSERT INTO public.production_machine_documents (
         id,machine_id,title,document_type,url,storage_path,revision,sha256,mime_type,size_bytes,authored_at,
         source_type,source_confidence,source_notes,retrieved_at,created_by
       ) VALUES ($1::uuid,$2::uuid,$3,$4,NULL,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12,$13,now(),$14)
       RETURNING id::text AS id,machine_model_id::text AS machine_model_id,machine_id::text AS machine_id,
         title,document_type,url,revision,sha256,mime_type,size_bytes::float8 AS size_bytes,
         authored_at::text AS authored_at,source_type,source_confidence,source_notes,
         retrieved_at::text AS retrieved_at,removed_at::text AS removed_at`,
      [
        id,
        params.machineId,
        b.title,
        b.document_type,
        toPosixStoragePath(finalPath),
        b.revision ?? null,
        sha256,
        params.file.mimetype,
        params.file.size,
        b.authored_at ?? null,
        b.source_type,
        b.source_confidence,
        b.source_notes ?? null,
        params.audit.user_id,
      ]
    );
    const created = result.rows[0];
    if (!created) throw new Error("Failed to upload machine document");
    await audit(client, params.audit, {
      action: "production.machines.document.upload",
      entityType: "production_machine_documents",
      entityId: id,
      details: {
        machine_id: params.machineId,
        title: b.title,
        document_type: b.document_type,
        mime_type: params.file.mimetype,
        size_bytes: params.file.size,
        sha256,
      },
    });
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    if (moved) await fs.unlink(finalPath).catch(() => undefined);
    else await fs.unlink(params.file.path).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function repoGetMachineDocumentForDownload(params: {
  machineId: string;
  documentId: string;
  audit: AuditContext;
}): Promise<MachineDocumentDownload | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ storage_path: string | null; mime_type: string | null; title: string }>(
      `SELECT storage_path, mime_type, title
         FROM public.production_machine_documents
        WHERE id=$1::uuid AND machine_id=$2::uuid AND removed_at IS NULL
        LIMIT 1`,
      [params.documentId, params.machineId]
    );
    const document = result.rows[0];
    if (!document?.storage_path) {
      await client.query("ROLLBACK");
      return null;
    }
    await audit(client, params.audit, {
      action: "production.machines.document.download",
      entityType: "production_machine_documents",
      entityId: params.documentId,
      details: { machine_id: params.machineId, title: document.title },
    });
    await client.query("COMMIT");
    return {
      storage_path: document.storage_path,
      mime_type: document.mime_type ?? "application/octet-stream",
      original_name: document.title,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoRemoveMachineDocument(params: { machineId: string; documentId: string; audit: AuditContext }): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE public.production_machine_documents SET removed_at=now(),removed_by=$3,updated_at=now()
        WHERE id=$1::uuid AND machine_id=$2::uuid AND removed_at IS NULL`,
      [params.documentId, params.machineId, params.audit.user_id]
    );
    if (!updated.rowCount) throw new HttpError(404, "MACHINE_DOCUMENT_NOT_FOUND", "Machine document not found.");
    await audit(client, params.audit, { action: "production.machines.document.remove", entityType: "production_machine_documents", entityId: params.documentId, details: { machine_id: params.machineId } });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
