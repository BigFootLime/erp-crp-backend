import type { PoolClient } from "pg";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { ProductionReadinessAuditContext, ProductionCalendarDTO } from "../types/production-readiness.types";
import type {
  ProductionCalendarClosureInput,
  ProductionCalendarInput,
  UpdateProductionCalendarInput,
} from "../validators/production-readiness.validators";

type Queryer = Pick<PoolClient, "query">;

type PrerequisiteRow = {
  prerequisite_code: string;
  ready: boolean;
  definition: string;
  unit: string;
  period_start: string | null;
  period_end: string | null;
  source: string;
  freshness_at: string | null;
  reliability: string;
  actual_value: Record<string, unknown> | unknown[] | null;
  expected_value: string;
  remediation: string;
};

const CALENDAR_COLUMNS = `
  c.id::text AS id,
  c.code,
  c.label,
  c.timezone,
  c.working_days,
  to_char(c.day_start, 'HH24:MI') AS day_start,
  to_char(c.day_end, 'HH24:MI') AS day_end,
  c.active,
  c.created_at::text AS created_at,
  c.updated_at::text AS updated_at,
  c.created_by,
  c.updated_by,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', closure.id::text,
      'start_date', closure.start_date::text,
      'end_date', closure.end_date::text,
      'reason', closure.reason,
      'created_at', closure.created_at::text,
      'created_by', closure.created_by
    ) ORDER BY closure.start_date, closure.end_date, closure.id)
    FROM public.programmation_calendar_closures closure
    WHERE closure.calendar_id = c.id
  ), '[]'::jsonb) AS closures
`;

function toIsoTimestamp(value: unknown, field: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${field} timestamp returned by PostgreSQL`);
  }
  return parsed.toISOString();
}

function mapCalendar(row: Record<string, unknown>): ProductionCalendarDTO {
  const closures = Array.isArray(row.closures)
    ? row.closures.map((raw) => {
        const closure = raw as Record<string, unknown>;
        return {
          id: String(closure.id),
          start_date: String(closure.start_date),
          end_date: String(closure.end_date),
          reason: String(closure.reason),
          created_at: toIsoTimestamp(closure.created_at, "closure.created_at"),
          created_by: closure.created_by === null ? null : Number(closure.created_by),
        };
      })
    : [];
  return {
    id: String(row.id),
    code: String(row.code),
    label: String(row.label),
    timezone: String(row.timezone),
    working_days: Array.isArray(row.working_days) ? row.working_days.map(Number) : [],
    day_start: String(row.day_start),
    day_end: String(row.day_end),
    active: Boolean(row.active),
    created_at: toIsoTimestamp(row.created_at, "calendar.created_at"),
    updated_at: toIsoTimestamp(row.updated_at, "calendar.updated_at"),
    created_by: row.created_by === null ? null : Number(row.created_by),
    updated_by: row.updated_by === null ? null : Number(row.updated_by),
    closures,
  };
}

async function insertAudit(
  tx: Queryer,
  audit: ProductionReadinessAuditContext,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>
): Promise<void> {
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body: {
      event_type: "ACTION",
      action,
      page_key: audit.page_key,
      entity_type: entityType,
      entity_id: entityId,
      path: audit.path,
      client_session_id: audit.client_session_id,
      details,
    },
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

async function readinessFunction(): Promise<"fn_business_prerequisite_status_v2" | "fn_business_prerequisite_status"> {
  const result = await db.query<{ v2: boolean; v1: boolean }>(
    `SELECT
       to_regprocedure('public.fn_business_prerequisite_status_v2(text)') IS NOT NULL AS v2,
       to_regprocedure('public.fn_business_prerequisite_status(text)') IS NOT NULL AS v1`
  );
  if (result.rows[0]?.v2) return "fn_business_prerequisite_status_v2";
  if (result.rows[0]?.v1) return "fn_business_prerequisite_status";
  throw new HttpError(
    503,
    "PRODUCTION_READINESS_NOT_INSTALLED",
    "Le contrôle de préparation production n'est pas installé. Appliquez les patches SOL-06 en environnement contrôlé."
  );
}

export async function repoReadProductionPrerequisites(): Promise<PrerequisiteRow[]> {
  const functionName = await readinessFunction();
  const result = await db.query<PrerequisiteRow>(
    `SELECT prerequisite_code, ready, definition, unit,
            period_start::text AS period_start, period_end::text AS period_end,
            source, freshness_at::text AS freshness_at, reliability,
            actual_value, expected_value, remediation
       FROM public.${functionName}($1)
      ORDER BY prerequisite_code`,
    ["PRODUCTION"]
  );
  return result.rows;
}

async function getCalendar(queryer: Queryer, calendarId: string): Promise<ProductionCalendarDTO | null> {
  const result = await queryer.query(`SELECT ${CALENDAR_COLUMNS} FROM public.programmation_calendars c WHERE c.id = $1`, [
    calendarId,
  ]);
  return result.rows[0] ? mapCalendar(result.rows[0]) : null;
}

export async function repoListProductionCalendars(): Promise<ProductionCalendarDTO[]> {
  const result = await db.query(`SELECT ${CALENDAR_COLUMNS} FROM public.programmation_calendars c ORDER BY c.active DESC, c.code`);
  return result.rows.map(mapCalendar);
}

function sameCalendar(calendar: ProductionCalendarDTO, input: ProductionCalendarInput): boolean {
  return (
    calendar.code === input.code &&
    calendar.label === input.label &&
    calendar.timezone === input.timezone &&
    calendar.day_start === input.day_start &&
    calendar.day_end === input.day_end &&
    calendar.active === input.active &&
    JSON.stringify([...calendar.working_days].sort()) === JSON.stringify([...input.working_days].sort())
  );
}

export async function repoCreateProductionCalendar(
  input: ProductionCalendarInput,
  audit: ProductionReadinessAuditContext
): Promise<{ calendar: ProductionCalendarDTO; created: boolean }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`production-calendar:${input.code}`]);
    const existing = await client.query(`SELECT id::text AS id FROM public.programmation_calendars WHERE code = $1`, [
      input.code,
    ]);
    if (existing.rows[0]) {
      const calendar = await getCalendar(client, String(existing.rows[0].id));
      if (calendar && sameCalendar(calendar, input)) {
        await client.query("COMMIT");
        return { calendar, created: false };
      }
      throw new HttpError(409, "PRODUCTION_CALENDAR_CODE_CONFLICT", `Le code ${input.code} est déjà utilisé.`);
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.programmation_calendars
         (code, label, timezone, working_days, day_start, day_end, active, created_by, updated_by)
       VALUES ($1,$2,$3,$4::smallint[],$5::time,$6::time,$7,$8,$8)
       RETURNING id::text AS id`,
      [
        input.code,
        input.label,
        input.timezone,
        input.working_days,
        input.day_start,
        input.day_end,
        input.active,
        audit.user_id,
      ]
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("Production calendar insert returned no id");
    await insertAudit(client, audit, "production.calendar.create", "production_calendar", id, {
      code: input.code,
      label: input.label,
      timezone: input.timezone,
      working_days: input.working_days,
      day_start: input.day_start,
      day_end: input.day_end,
      active: input.active,
    });
    const calendar = await getCalendar(client, id);
    await client.query("COMMIT");
    return { calendar: calendar as ProductionCalendarDTO, created: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function repoUpdateProductionCalendar(
  calendarId: string,
  input: UpdateProductionCalendarInput,
  audit: ProductionReadinessAuditContext
): Promise<ProductionCalendarDTO> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const before = await client.query(
      `SELECT id::text AS id, code, label, timezone, working_days,
              to_char(day_start, 'HH24:MI') AS day_start,
              to_char(day_end, 'HH24:MI') AS day_end, active, updated_at::text AS updated_at
         FROM public.programmation_calendars WHERE id = $1 FOR UPDATE`,
      [calendarId]
    );
    if (!before.rows[0]) throw new HttpError(404, "PRODUCTION_CALENDAR_NOT_FOUND", "Calendrier introuvable.");
    if (new Date(String(before.rows[0].updated_at)).toISOString() !== new Date(input.expected_updated_at).toISOString()) {
      throw new HttpError(
        409,
        "CONCURRENT_MODIFICATION",
        "Ce calendrier a été modifié entre-temps. Rechargez la page avant de confirmer."
      );
    }
    const duplicate = await client.query(
      `SELECT 1 FROM public.programmation_calendars WHERE code = $1 AND id <> $2`,
      [input.code, calendarId]
    );
    if ((duplicate.rowCount ?? 0) > 0) {
      throw new HttpError(409, "PRODUCTION_CALENDAR_CODE_CONFLICT", `Le code ${input.code} est déjà utilisé.`);
    }
    await client.query(
      `UPDATE public.programmation_calendars
          SET code=$1, label=$2, timezone=$3, working_days=$4::smallint[],
              day_start=$5::time, day_end=$6::time, active=$7, updated_by=$8
        WHERE id=$9`,
      [
        input.code,
        input.label,
        input.timezone,
        input.working_days,
        input.day_start,
        input.day_end,
        input.active,
        audit.user_id,
        calendarId,
      ]
    );
    await insertAudit(client, audit, "production.calendar.update", "production_calendar", calendarId, {
      before: before.rows[0],
      after: { ...input, expected_updated_at: undefined },
    });
    const calendar = await getCalendar(client, calendarId);
    await client.query("COMMIT");
    return calendar as ProductionCalendarDTO;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function repoCreateCalendarClosure(
  calendarId: string,
  input: ProductionCalendarClosureInput,
  audit: ProductionReadinessAuditContext
): Promise<{ calendar: ProductionCalendarDTO; created: boolean }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `production-calendar-closure:${calendarId}:${input.start_date}:${input.end_date}:${input.reason}`,
    ]);
    const calendar = await client.query(`SELECT id FROM public.programmation_calendars WHERE id = $1 FOR UPDATE`, [calendarId]);
    if (!calendar.rows[0]) throw new HttpError(404, "PRODUCTION_CALENDAR_NOT_FOUND", "Calendrier introuvable.");
    const existing = await client.query(
      `SELECT id::text AS id FROM public.programmation_calendar_closures
        WHERE calendar_id=$1 AND start_date=$2::date AND end_date=$3::date AND reason=$4`,
      [calendarId, input.start_date, input.end_date, input.reason]
    );
    if (existing.rows[0]) {
      const reloaded = await getCalendar(client, calendarId);
      await client.query("COMMIT");
      return { calendar: reloaded as ProductionCalendarDTO, created: false };
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.programmation_calendar_closures (calendar_id,start_date,end_date,reason,created_by)
       VALUES ($1,$2::date,$3::date,$4,$5) RETURNING id::text AS id`,
      [calendarId, input.start_date, input.end_date, input.reason, audit.user_id]
    );
    const closureId = inserted.rows[0]?.id;
    if (!closureId) throw new Error("Production calendar closure insert returned no id");
    await insertAudit(client, audit, "production.calendar.closure.create", "production_calendar_closure", closureId, {
      calendar_id: calendarId,
      ...input,
    });
    const reloaded = await getCalendar(client, calendarId);
    await client.query("COMMIT");
    return { calendar: reloaded as ProductionCalendarDTO, created: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function repoDeleteCalendarClosure(
  calendarId: string,
  closureId: string,
  audit: ProductionReadinessAuditContext
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT id::text AS id, calendar_id::text AS calendar_id,
              start_date::text AS start_date, end_date::text AS end_date, reason
         FROM public.programmation_calendar_closures
        WHERE id=$1 AND calendar_id=$2 FOR UPDATE`,
      [closureId, calendarId]
    );
    if (!existing.rows[0]) throw new HttpError(404, "PRODUCTION_CALENDAR_CLOSURE_NOT_FOUND", "Fermeture introuvable.");
    await client.query(`DELETE FROM public.programmation_calendar_closures WHERE id=$1`, [closureId]);
    await insertAudit(client, audit, "production.calendar.closure.delete", "production_calendar_closure", closureId, {
      before: existing.rows[0],
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
