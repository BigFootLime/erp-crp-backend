import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import { defaultPlanningPreferences } from "../domain/planning-intelligence";
import type {
  PlanningCapacityRawRow,
  PlanningIntelligenceEventRow,
  PlanningIntelligencePointageRow,
  PlanningIntelligenceSnapshot,
  PlanningQuantityRow,
  PlanningWipRow,
} from "../domain/planning-intelligence";
import type { PlanningPreferences } from "../types/planning-intelligence.types";
import type { AuditContext } from "./planning.repository";
import type {
  PlanningIntelligenceQueryDTO,
  PlanningPreferencesBodyDTO,
} from "../validators/planning-intelligence.validators";

type Queryer = Pick<PoolClient, "query">;

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("PLANNING_INTELLIGENCE_INVALID_NUMERIC_SOURCE");
  }
  return parsed;
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

function mapEvent(row: Record<string, unknown>): PlanningIntelligenceEventRow {
  return {
    event_id: String(row.event_id),
    of_id: nullableNum(row.of_id),
    of_numero: text(row.of_numero),
    operation_id: text(row.operation_id),
    phase: nullableNum(row.phase),
    designation: text(row.designation),
    event_status: String(row.event_status ?? ""),
    operation_status: text(row.operation_status),
    start_ts: String(row.start_ts),
    end_ts: String(row.end_ts),
    updated_at: String(row.updated_at),
    operation_ended_at: text(row.operation_ended_at),
    planned_hours: nullableNum(row.planned_hours),
    machine_id: text(row.machine_id),
    machine_code: text(row.machine_code),
    machine_name: text(row.machine_name),
    machine_available: row.machine_available === null || row.machine_available === undefined ? null : Boolean(row.machine_available),
    allow_overlap: Boolean(row.allow_overlap),
  };
}

async function listEvents(query: PlanningIntelligenceQueryDTO): Promise<PlanningIntelligenceEventRow[]> {
  const { rows } = await pool.query(
    `
      SELECT e.id::text AS event_id,
             COALESCE(e.of_id, op.of_id)::text AS of_id,
             ofa.numero AS of_numero,
             e.of_operation_id::text AS operation_id,
             op.phase::int AS phase,
             op.designation,
             e.status::text AS event_status,
             op.status::text AS operation_status,
             e.start_ts::text AS start_ts,
             e.end_ts::text AS end_ts,
             e.updated_at::text AS updated_at,
             op.ended_at::text AS operation_ended_at,
             CASE WHEN op.temps_total_planned > 0 THEN op.temps_total_planned::float8 ELSE NULL END AS planned_hours,
             COALESCE(e.machine_id, poste.machine_id, op.machine_id)::text AS machine_id,
             machine.code AS machine_code,
             machine.name AS machine_name,
             machine.is_available AS machine_available,
             e.allow_overlap
        FROM public.planning_events e
        LEFT JOIN public.of_operations op ON op.id = e.of_operation_id
        LEFT JOIN public.ordres_fabrication ofa ON ofa.id = COALESCE(e.of_id, op.of_id)
        LEFT JOIN public.postes poste ON poste.id = e.poste_id
        LEFT JOIN public.machines machine ON machine.id = COALESCE(e.machine_id, poste.machine_id, op.machine_id)
       WHERE e.archived_at IS NULL
         AND e.kind::text = 'OF_OPERATION'
         AND (
           tstzrange(e.start_ts, e.end_ts, '[)') && tstzrange($1::timestamptz, $2::timestamptz, '[)')
           OR (op.ended_at >= $1::timestamptz AND op.ended_at < $2::timestamptz)
         )
         AND ($3::uuid IS NULL OR COALESCE(e.machine_id, poste.machine_id, op.machine_id) = $3::uuid)
         AND ($4::text IS NULL OR machine.workshop_zone = $4::text)
       ORDER BY e.start_ts, e.id
    `,
    [query.from, query.to, query.machine_id ?? null, query.workshop_zone ?? null]
  );
  return rows.map((row) => mapEvent(row as Record<string, unknown>));
}

async function listPointages(query: PlanningIntelligenceQueryDTO): Promise<PlanningIntelligencePointageRow[]> {
  const { rows } = await pool.query(
    `
      SELECT p.id::text AS pointage_id,
             p.of_id::text AS of_id,
             p.operation_id::text AS operation_id,
             p.machine_id::text AS machine_id,
             machine.code AS machine_code,
             p.activity_code,
             category.label AS activity_label,
             category.is_productive AS activity_is_productive,
             (p.status::text = 'RUNNING') AS is_running,
             p.start_ts::text AS start_ts,
             COALESCE(p.end_ts, now())::text AS end_ts,
             GREATEST(0, EXTRACT(EPOCH FROM (
               LEAST(COALESCE(p.end_ts, now()), $2::timestamptz)
               - GREATEST(p.start_ts, $1::timestamptz)
             )) / 60.0)::float8 AS duration_minutes,
             p.comment,
             p.updated_at::text AS updated_at
        FROM public.production_pointages p
        LEFT JOIN public.production_activity_categories category ON category.code = p.activity_code
        LEFT JOIN public.machines machine ON machine.id = p.machine_id
       WHERE p.status::text IN ('RUNNING', 'DONE')
         AND tstzrange(p.start_ts, COALESCE(p.end_ts, now()), '[)')
             && tstzrange($1::timestamptz, $2::timestamptz, '[)')
         AND ($3::uuid IS NULL OR p.machine_id = $3::uuid)
         AND ($4::text IS NULL OR machine.workshop_zone = $4::text)
       ORDER BY p.start_ts, p.id
    `,
    [query.from, query.to, query.machine_id ?? null, query.workshop_zone ?? null]
  );
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      pointage_id: String(row.pointage_id),
      of_id: num(row.of_id),
      operation_id: text(row.operation_id),
      machine_id: text(row.machine_id),
      machine_code: text(row.machine_code),
      activity_code: text(row.activity_code),
      activity_label: text(row.activity_label),
      activity_is_productive: row.activity_is_productive === null || row.activity_is_productive === undefined ? null : Boolean(row.activity_is_productive),
      is_running: Boolean(row.is_running),
      start_ts: String(row.start_ts),
      end_ts: String(row.end_ts),
      duration_minutes: num(row.duration_minutes),
      comment: text(row.comment),
      updated_at: String(row.updated_at),
    };
  });
}

async function listQuantities(query: PlanningIntelligenceQueryDTO): Promise<PlanningQuantityRow[]> {
  const { rows } = await pool.query(
    `
      SELECT COALESCE(NULLIF(btrim(declaration.unite), ''), 'UNSPECIFIED') AS unit,
             SUM(declaration.qty_good)::float8 AS qty_good,
             SUM(declaration.qty_scrap)::float8 AS qty_scrap,
             SUM(declaration.qty_rework)::float8 AS qty_rework,
             MAX(declaration.declared_at)::text AS freshness_at
        FROM public.production_quantity_declarations declaration
        LEFT JOIN public.of_operations operation ON operation.id = declaration.operation_id
        LEFT JOIN public.machines machine ON machine.id = operation.machine_id
       WHERE declaration.declared_at >= $1::timestamptz
         AND declaration.declared_at < $2::timestamptz
         AND ($3::uuid IS NULL OR operation.machine_id = $3::uuid)
         AND ($4::text IS NULL OR machine.workshop_zone = $4::text)
       GROUP BY COALESCE(NULLIF(btrim(declaration.unite), ''), 'UNSPECIFIED')
       ORDER BY unit
    `,
    [query.from, query.to, query.machine_id ?? null, query.workshop_zone ?? null]
  );
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      unit: String(row.unit),
      qty_good: num(row.qty_good),
      qty_scrap: num(row.qty_scrap),
      qty_rework: num(row.qty_rework),
      freshness_at: text(row.freshness_at),
    };
  });
}

async function listWip(query: PlanningIntelligenceQueryDTO): Promise<PlanningWipRow[]> {
  const { rows } = await pool.query(
    `
      SELECT ofa.id::text AS of_id,
             ofa.numero AS of_numero,
             operation.id::text AS operation_id,
             operation.machine_id::text AS machine_id,
             COALESCE(ofa.date_lancement_reelle::timestamptz, first_pointage.started_at, operation.started_at)::text AS started_at,
             ofa.date_fin_prevue::text AS due_date
        FROM public.ordres_fabrication ofa
        JOIN LATERAL (
          SELECT op.*
            FROM public.of_operations op
           WHERE op.of_id = ofa.id
             AND op.status::text NOT IN ('DONE', 'CANCELLED')
           ORDER BY CASE WHEN op.status::text = 'RUNNING' THEN 0 ELSE 1 END, op.phase
           LIMIT 1
        ) operation ON true
        LEFT JOIN public.machines machine ON machine.id = operation.machine_id
        LEFT JOIN LATERAL (
          SELECT MIN(pointage.start_ts) AS started_at
            FROM public.production_pointages pointage
           WHERE pointage.of_id = ofa.id
             AND pointage.status::text IN ('RUNNING', 'DONE')
        ) first_pointage ON true
       WHERE ofa.statut::text NOT IN ('BROUILLON', 'ANNULE', 'TERMINE', 'CLOTURE')
         AND (
           ofa.statut::text IN ('EN_COURS', 'EN_PAUSE')
           OR operation.status::text = 'RUNNING'
           OR EXISTS (SELECT 1 FROM public.production_pointages active WHERE active.of_id = ofa.id AND active.status::text = 'RUNNING')
         )
         AND ($1::uuid IS NULL OR operation.machine_id = $1::uuid)
         AND ($2::text IS NULL OR machine.workshop_zone = $2::text)
       ORDER BY ofa.date_fin_prevue NULLS LAST, ofa.id
    `,
    [query.machine_id ?? null, query.workshop_zone ?? null]
  );
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      of_id: num(row.of_id),
      of_numero: String(row.of_numero),
      operation_id: text(row.operation_id),
      machine_id: text(row.machine_id),
      started_at: text(row.started_at),
      due_date: text(row.due_date),
    };
  });
}

type CapacityBase = {
  machine_id: string;
  machine_code: string;
  machine_name: string;
  week_start: string;
  available_minutes: number | null;
  unavailable_minutes: number;
  calendar_count: number;
  calendar_freshness_at: string | null;
};

async function listCapacityBase(query: PlanningIntelligenceQueryDTO): Promise<CapacityBase[]> {
  const { rows } = await pool.query(
    `
      WITH calendar_state AS (
        SELECT count(*)::int AS calendar_count,
               max(updated_at)::text AS calendar_freshness_at,
               (SELECT selected.timezone FROM public.programmation_calendars selected WHERE selected.active ORDER BY selected.updated_at DESC, selected.id LIMIT 1) AS timezone,
               (SELECT selected.working_days FROM public.programmation_calendars selected WHERE selected.active ORDER BY selected.updated_at DESC, selected.id LIMIT 1) AS working_days,
               (SELECT selected.day_start FROM public.programmation_calendars selected WHERE selected.active ORDER BY selected.updated_at DESC, selected.id LIMIT 1) AS day_start,
               (SELECT selected.day_end FROM public.programmation_calendars selected WHERE selected.active ORDER BY selected.updated_at DESC, selected.id LIMIT 1) AS day_end,
               (SELECT selected.id FROM public.programmation_calendars selected WHERE selected.active ORDER BY selected.updated_at DESC, selected.id LIMIT 1) AS calendar_id
          FROM public.programmation_calendars
         WHERE active
      ), settings AS (
        SELECT calendar_state.*,
               CASE WHEN calendar_count = 1 THEN timezone ELSE $3::text END AS effective_timezone
          FROM calendar_state
      ), weeks AS (
        SELECT generate_series(
                 date_trunc('week', $1::timestamptz AT TIME ZONE settings.effective_timezone)::date,
                 date_trunc('week', ($2::timestamptz - interval '1 microsecond') AT TIME ZONE settings.effective_timezone)::date,
                 interval '1 week'
               )::date AS week_start,
               settings.*
          FROM settings
      ), work_slots AS (
        SELECT week.week_start,
               ((day.value::date + week.day_start) AT TIME ZONE week.effective_timezone) AS slot_start,
               ((day.value::date + week.day_end) AT TIME ZONE week.effective_timezone) AS slot_end
          FROM weeks week
          CROSS JOIN LATERAL generate_series(week.week_start, week.week_start + 6, interval '1 day') AS day(value)
         WHERE week.calendar_count = 1
           AND EXTRACT(ISODOW FROM day.value)::int = ANY(week.working_days)
           AND NOT EXISTS (
             SELECT 1 FROM public.programmation_calendar_closures closure
              WHERE closure.calendar_id = week.calendar_id
                AND day.value::date BETWEEN closure.start_date AND closure.end_date
           )
      ), machines_scope AS (
        SELECT machine.id, machine.code, machine.name
          FROM public.machines machine
         WHERE machine.archived_at IS NULL
           AND ($4::uuid IS NULL OR machine.id = $4::uuid)
           AND ($5::text IS NULL OR machine.workshop_zone = $5::text)
      ), capacity_by_machine_week AS (
        SELECT machine.id AS machine_id,
               machine.code AS machine_code,
               machine.name AS machine_name,
               week.week_start,
               week.calendar_count,
               week.calendar_freshness_at,
               CASE WHEN week.calendar_count = 1 THEN
                 COALESCE(SUM(EXTRACT(EPOCH FROM (slot.slot_end - slot.slot_start)) / 60.0), 0)::float8
               ELSE NULL END AS nominal_minutes,
               CASE WHEN week.calendar_count = 1 THEN
                 COALESCE(SUM((
                   SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
                     LEAST(event.end_ts, slot.slot_end) - GREATEST(event.start_ts, slot.slot_start)
                   )) / 60.0), 0)
                     FROM public.production_machine_unavailability unavailable
                     JOIN public.planning_events event ON event.id = unavailable.planning_event_id
                    WHERE unavailable.machine_id = machine.id
                      AND unavailable.archived_at IS NULL
                      AND event.archived_at IS NULL
                      AND event.status::text <> 'CANCELLED'
                      AND tstzrange(event.start_ts, event.end_ts, '[)')
                          && tstzrange(slot.slot_start, slot.slot_end, '[)')
                 )), 0)::float8
               ELSE 0 END AS unavailable_minutes,
               GREATEST(
                 week.calendar_freshness_at::timestamptz,
                 (
                   SELECT MAX(GREATEST(unavailable.updated_at, event.updated_at))
                     FROM public.production_machine_unavailability unavailable
                     JOIN public.planning_events event ON event.id = unavailable.planning_event_id
                    WHERE unavailable.machine_id = machine.id
                      AND unavailable.archived_at IS NULL
                      AND event.archived_at IS NULL
                      AND event.status::text <> 'CANCELLED'
                      AND tstzrange(event.start_ts, event.end_ts, '[)') && tstzrange(
                            week.week_start::timestamp AT TIME ZONE week.effective_timezone,
                            (week.week_start + 7)::timestamp AT TIME ZONE week.effective_timezone,
                            '[)'
                          )
                 )
               )::text AS capacity_freshness_at
          FROM weeks week
          CROSS JOIN machines_scope machine
          LEFT JOIN work_slots slot ON slot.week_start = week.week_start
         GROUP BY machine.id, machine.code, machine.name, week.week_start,
                  week.calendar_count, week.calendar_freshness_at, week.effective_timezone
      )
      SELECT machine.id::text AS machine_id,
             machine.code AS machine_code,
             machine.name AS machine_name,
             week.week_start::text AS week_start,
             CASE WHEN week.nominal_minutes IS NOT NULL
                  THEN GREATEST(0, week.nominal_minutes - week.unavailable_minutes)
                  ELSE NULL END AS available_minutes,
             week.unavailable_minutes,
             week.calendar_count,
             week.capacity_freshness_at AS calendar_freshness_at
        FROM capacity_by_machine_week week
        JOIN machines_scope machine ON machine.id = week.machine_id
       ORDER BY week.week_start, machine.code
    `,
    [query.from, query.to, query.timezone, query.machine_id ?? null, query.workshop_zone ?? null]
  );
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      machine_id: String(row.machine_id),
      machine_code: String(row.machine_code),
      machine_name: String(row.machine_name),
      week_start: String(row.week_start).slice(0, 10),
      available_minutes: nullableNum(row.available_minutes),
      unavailable_minutes: num(row.unavailable_minutes),
      calendar_count: num(row.calendar_count),
      calendar_freshness_at: text(row.calendar_freshness_at),
    };
  });
}

async function listCapacityPlanned(query: PlanningIntelligenceQueryDTO): Promise<Array<{
  machine_id: string;
  week_start: string;
  event: PlanningIntelligenceEventRow;
  planned_minutes: number;
}>> {
  const { rows } = await pool.query(
    `
      WITH calendar_state AS (
        SELECT count(*)::int AS calendar_count,
               (SELECT selected.timezone FROM public.programmation_calendars selected WHERE selected.active ORDER BY selected.updated_at DESC, selected.id LIMIT 1) AS timezone
          FROM public.programmation_calendars WHERE active
      ), settings AS (
        SELECT CASE WHEN calendar_count = 1 THEN timezone ELSE $3::text END AS timezone FROM calendar_state
      ), weeks AS (
        SELECT generate_series(
                 date_trunc('week', $1::timestamptz AT TIME ZONE settings.timezone)::date,
                 date_trunc('week', ($2::timestamptz - interval '1 microsecond') AT TIME ZONE settings.timezone)::date,
                 interval '1 week'
               )::date AS week_start,
               settings.timezone
          FROM settings
      )
      SELECT e.id::text AS event_id,
             COALESCE(e.of_id, operation.of_id)::text AS of_id,
             ofa.numero AS of_numero,
             e.of_operation_id::text AS operation_id,
             operation.phase::int AS phase,
             operation.designation,
             e.status::text AS event_status,
             operation.status::text AS operation_status,
             e.start_ts::text AS start_ts,
             e.end_ts::text AS end_ts,
             e.updated_at::text AS updated_at,
             operation.ended_at::text AS operation_ended_at,
             CASE WHEN operation.temps_total_planned > 0 THEN operation.temps_total_planned::float8 ELSE NULL END AS planned_hours,
             machine.id::text AS machine_id,
             machine.code AS machine_code,
             machine.name AS machine_name,
             machine.is_available AS machine_available,
             e.allow_overlap,
             week.week_start::text AS week_start,
             GREATEST(0, EXTRACT(EPOCH FROM (
               LEAST(e.end_ts, (week.week_start + 7)::timestamp AT TIME ZONE week.timezone)
               - GREATEST(e.start_ts, week.week_start::timestamp AT TIME ZONE week.timezone)
             )) / 60.0)::float8 AS planned_minutes
        FROM weeks week
        JOIN public.planning_events e
          ON tstzrange(e.start_ts, e.end_ts, '[)') && tstzrange(
               week.week_start::timestamp AT TIME ZONE week.timezone,
               (week.week_start + 7)::timestamp AT TIME ZONE week.timezone,
               '[)'
             )
        LEFT JOIN public.of_operations operation ON operation.id = e.of_operation_id
        LEFT JOIN public.ordres_fabrication ofa ON ofa.id = COALESCE(e.of_id, operation.of_id)
        LEFT JOIN public.postes poste ON poste.id = e.poste_id
        JOIN public.machines machine ON machine.id = COALESCE(e.machine_id, poste.machine_id, operation.machine_id)
       WHERE e.archived_at IS NULL
         AND e.kind::text = 'OF_OPERATION'
         AND e.status::text <> 'CANCELLED'
         AND ($4::uuid IS NULL OR machine.id = $4::uuid)
         AND ($5::text IS NULL OR machine.workshop_zone = $5::text)
       ORDER BY week.week_start, machine.code, e.start_ts
    `,
    [query.from, query.to, query.timezone, query.machine_id ?? null, query.workshop_zone ?? null]
  );
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      machine_id: String(row.machine_id),
      week_start: String(row.week_start).slice(0, 10),
      event: mapEvent(row),
      planned_minutes: num(row.planned_minutes),
    };
  });
}

async function listCapacityActual(query: PlanningIntelligenceQueryDTO): Promise<Array<{ machine_id: string; week_start: string; actual_minutes: number }>> {
  const { rows } = await pool.query(
    `
      WITH calendar_state AS (
        SELECT count(*)::int AS calendar_count,
               (SELECT selected.timezone FROM public.programmation_calendars selected WHERE selected.active ORDER BY selected.updated_at DESC, selected.id LIMIT 1) AS timezone
          FROM public.programmation_calendars WHERE active
      ), settings AS (
        SELECT CASE WHEN calendar_count = 1 THEN timezone ELSE $3::text END AS timezone FROM calendar_state
      ), weeks AS (
        SELECT generate_series(
                 date_trunc('week', $1::timestamptz AT TIME ZONE settings.timezone)::date,
                 date_trunc('week', ($2::timestamptz - interval '1 microsecond') AT TIME ZONE settings.timezone)::date,
                 interval '1 week'
               )::date AS week_start,
               settings.timezone
          FROM settings
      )
      SELECT pointage.machine_id::text AS machine_id,
             week.week_start::text AS week_start,
             SUM(GREATEST(0, EXTRACT(EPOCH FROM (
               LEAST(COALESCE(pointage.end_ts, now()), (week.week_start + 7)::timestamp AT TIME ZONE week.timezone)
               - GREATEST(pointage.start_ts, week.week_start::timestamp AT TIME ZONE week.timezone)
             )) / 60.0))::float8 AS actual_minutes
        FROM weeks week
        JOIN public.production_pointages pointage
          ON pointage.machine_id IS NOT NULL
         AND pointage.status::text IN ('RUNNING', 'DONE')
         AND tstzrange(pointage.start_ts, COALESCE(pointage.end_ts, now()), '[)') && tstzrange(
               week.week_start::timestamp AT TIME ZONE week.timezone,
               (week.week_start + 7)::timestamp AT TIME ZONE week.timezone,
               '[)'
             )
        JOIN public.machines machine ON machine.id = pointage.machine_id
       WHERE ($4::uuid IS NULL OR machine.id = $4::uuid)
         AND ($5::text IS NULL OR machine.workshop_zone = $5::text)
       GROUP BY pointage.machine_id, week.week_start
       ORDER BY week.week_start, pointage.machine_id
    `,
    [query.from, query.to, query.timezone, query.machine_id ?? null, query.workshop_zone ?? null]
  );
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      machine_id: String(row.machine_id),
      week_start: String(row.week_start).slice(0, 10),
      actual_minutes: num(row.actual_minutes),
    };
  });
}

export async function repoGetPlanningIntelligenceSnapshot(query: PlanningIntelligenceQueryDTO): Promise<PlanningIntelligenceSnapshot> {
  const [events, pointages, quantities, wip, base, planned, actual] = await Promise.all([
    listEvents(query),
    listPointages(query),
    listQuantities(query),
    listWip(query),
    listCapacityBase(query),
    listCapacityPlanned(query),
    listCapacityActual(query),
  ]);
  const byKey = new Map(base.map((row) => [`${row.machine_id}:${row.week_start}`, row]));
  const capacity: PlanningCapacityRawRow[] = base.map((row) => ({
    ...row,
    planned_event: null,
    planned_minutes: 0,
    actual_minutes: 0,
  }));
  for (const item of planned) {
    const baseRow = byKey.get(`${item.machine_id}:${item.week_start}`);
    if (!baseRow) continue;
    capacity.push({ ...baseRow, planned_event: item.event, planned_minutes: item.planned_minutes, actual_minutes: 0 });
  }
  for (const item of actual) {
    const baseRow = byKey.get(`${item.machine_id}:${item.week_start}`);
    if (!baseRow) continue;
    capacity.push({ ...baseRow, planned_event: null, planned_minutes: 0, actual_minutes: item.actual_minutes });
  }
  return { events, pointages, quantities, wip, capacity };
}

function mapPreferences(row: Record<string, unknown> | undefined): PlanningPreferences {
  if (!row) return defaultPlanningPreferences();
  return {
    timezone: String(row.timezone),
    horizon_weeks: num(row.horizon_weeks),
    view_mode: String(row.view_mode) as PlanningPreferences["view_mode"],
    show_weekends: Boolean(row.show_weekends),
    machine_ids: Array.isArray(row.machine_ids) ? row.machine_ids.map(String) : [],
    status_colors: recordOfStrings(row.status_colors),
    client_color_overrides: recordOfStrings(row.client_color_overrides),
    updated_at: text(row.updated_at),
  };
}

export async function repoGetPlanningPreferences(userId: number): Promise<PlanningPreferences> {
  const result = await pool.query(
    `SELECT timezone, horizon_weeks, view_mode, show_weekends, machine_ids,
            status_colors, client_color_overrides, updated_at::text AS updated_at
       FROM public.planning_user_preferences
      WHERE user_id = $1`,
    [userId]
  );
  return mapPreferences(result.rows[0] as Record<string, unknown> | undefined);
}

async function insertPreferenceAudit(tx: Queryer, audit: AuditContext, before: PlanningPreferences | null, after: PlanningPreferences): Promise<void> {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: "planning.preferences.upsert",
    page_key: audit.page_key,
    entity_type: "planning_user_preferences",
    entity_id: String(audit.user_id),
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: { before, after },
  };
  const inserted = await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
  if (!inserted?.id) throw new Error("PLANNING_PREFERENCES_AUDIT_FAILED");
}

function samePreferences(before: PlanningPreferences, body: PlanningPreferencesBodyDTO): boolean {
  return JSON.stringify({
    timezone: before.timezone,
    horizon_weeks: before.horizon_weeks,
    view_mode: before.view_mode,
    show_weekends: before.show_weekends,
    machine_ids: before.machine_ids,
    status_colors: before.status_colors,
    client_color_overrides: before.client_color_overrides,
  }) === JSON.stringify({
    timezone: body.timezone,
    horizon_weeks: body.horizon_weeks,
    view_mode: body.view_mode,
    show_weekends: body.show_weekends,
    machine_ids: body.machine_ids,
    status_colors: body.status_colors,
    client_color_overrides: body.client_color_overrides,
  });
}

export async function repoPutPlanningPreferences(params: {
  body: PlanningPreferencesBodyDTO;
  audit: AuditContext;
}): Promise<PlanningPreferences> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT timezone, horizon_weeks, view_mode, show_weekends, machine_ids,
              status_colors, client_color_overrides, updated_at::text AS updated_at
         FROM public.planning_user_preferences
        WHERE user_id = $1
        FOR UPDATE`,
      [params.audit.user_id]
    );
    const existingRow = locked.rows[0] as Record<string, unknown> | undefined;
    const before = existingRow ? mapPreferences(existingRow) : null;
    if (before && params.body.expected_updated_at && before.updated_at !== params.body.expected_updated_at) {
      throw new HttpError(409, "PLANNING_PREFERENCES_STALE", "Planning preferences were updated by another session", {
        expected_updated_at: params.body.expected_updated_at,
        actual_updated_at: before.updated_at,
      });
    }
    if (before && samePreferences(before, params.body)) {
      await client.query("COMMIT");
      return before;
    }
    if (params.body.machine_ids.length) {
      const knownMachines = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM public.machines
          WHERE id = ANY($1::uuid[])
            AND archived_at IS NULL`,
        [params.body.machine_ids]
      );
      if (knownMachines.rows[0]?.count !== params.body.machine_ids.length) {
        throw new HttpError(422, "PLANNING_PREFERENCE_MACHINE_UNKNOWN", "At least one planning machine is unknown or archived");
      }
    }
    const result = await client.query(
      `INSERT INTO public.planning_user_preferences
         (user_id, timezone, horizon_weeks, view_mode, show_weekends, machine_ids,
          status_colors, client_color_overrides, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7::jsonb,$8::jsonb,$1,$1)
       ON CONFLICT (user_id) DO UPDATE
         SET timezone = EXCLUDED.timezone,
             horizon_weeks = EXCLUDED.horizon_weeks,
             view_mode = EXCLUDED.view_mode,
             show_weekends = EXCLUDED.show_weekends,
             machine_ids = EXCLUDED.machine_ids,
             status_colors = EXCLUDED.status_colors,
             client_color_overrides = EXCLUDED.client_color_overrides,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       RETURNING timezone, horizon_weeks, view_mode, show_weekends, machine_ids,
                 status_colors, client_color_overrides, updated_at::text AS updated_at`,
      [
        params.audit.user_id,
        params.body.timezone,
        params.body.horizon_weeks,
        params.body.view_mode,
        params.body.show_weekends,
        params.body.machine_ids,
        JSON.stringify(params.body.status_colors),
        JSON.stringify(params.body.client_color_overrides),
      ]
    );
    const after = mapPreferences(result.rows[0] as Record<string, unknown>);
    await insertPreferenceAudit(client, params.audit, before, after);
    await client.query("COMMIT");
    return after;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
