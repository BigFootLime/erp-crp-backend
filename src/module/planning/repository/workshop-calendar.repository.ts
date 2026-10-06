import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withPlanningCommand } from "./planning-command.repository";
import type { AuditContext } from "./planning.repository";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
export async function readWorkshopCalendar() {
    const result = await pool.query(`SELECT s.workshop_calendar_id::text AS selected_id,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'label',c.label,'timezone',c.timezone,
      'working_days',c.working_days,'day_start',c.day_start::text,'day_end',c.day_end::text) ORDER BY c.label)
      FROM public.programmation_calendars c WHERE c.active AND c.day_start<c.day_end),'[]'::jsonb) AS calendars
    FROM public.planning_central_settings s WHERE s.singleton`);
    return result.rows[0];
}
export async function setWorkshopCalendar(input: {
    calendar_id: string;
    expected_revision: string;
}, audit: AuditContext, key: string) {
    return withPlanningCommand(audit, key, "workshop-calendar", input, async (tx) => {
        const settings = (await tx.query<{
            revision: string;
        }>("SELECT revision::text FROM public.planning_central_settings WHERE singleton FOR UPDATE")).rows[0];
        if (settings.revision !== input.expected_revision)
            throw new HttpError(409, "PLANNING_STALE", "Le planning a changé. Rechargez les calendriers.");
        const calendar = (await tx.query("SELECT id FROM public.programmation_calendars WHERE id=$1::uuid AND active AND day_start<day_end FOR SHARE", [input.calendar_id])).rows[0];
        if (!calendar)
            throw new HttpError(422, "WORKSHOP_CALENDAR_INVALID", "Choisissez un calendrier actif avec des horaires d'atelier.");
        await tx.query("UPDATE public.planning_central_settings SET workshop_calendar_id=$1,revision=revision+1,updated_at=clock_timestamp() WHERE singleton", [input.calendar_id]);
        await repoInsertAuditLog({ tx, user_id: audit.user_id, ip: audit.ip, user_agent: audit.user_agent, device_type: audit.device_type, os: audit.os, browser: audit.browser,
            body: { event_type: "ACTION", action: "planning.workshop-calendar.configure", entity_type: "planning_central_settings", entity_id: "true", path: audit.path, page_key: audit.page_key, client_session_id: audit.client_session_id, details: input } });
        return { selected_id: input.calendar_id };
    });
}
