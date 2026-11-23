import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { SaveAssemblyWeek } from "../validators/assembly-planning.validators";

const teamKey = "planning.assembly.team";
const weekKey = (week: string) => "planning.assembly.presence." + week;

const settingsQuery = "SELECT key, value_json, updated_at::text AS version FROM public.erp_settings WHERE key = ANY($1::text[])";

export async function readAssemblyWeekSettings(week: string) {
  const settings = await db.query<{ key: string; value_json: unknown; version: string }>(settingsQuery, [[teamKey, weekKey(week)]]);
  return {
    teamSetting: settings.rows.find((row) => row.key === teamKey),
    weekSetting: settings.rows.find((row) => row.key === weekKey(week)),
  };
}

export async function readAssemblyOperations(week: string) {
  const operations = await db.query(
    `WITH bounds AS (
      SELECT $1::date::timestamp AT TIME ZONE 'Europe/Paris' AS starts,
            ($1::date + 7)::timestamp AT TIME ZONE 'Europe/Paris' AS ends
    )
    SELECT COALESCE(e.id,op.id)::text AS id, o.id::text AS of_id, o.numero,
      op.phase, op.designation, cf.designation AS cost_center, e.start_ts, e.end_ts,
      CASE WHEN e.id IS NOT NULL THEN
        ROUND(EXTRACT(EPOCH FROM (LEAST(e.end_ts, b.ends) - GREATEST(e.start_ts, b.starts))) / 60)::int
      END AS minutes
    FROM public.of_operations op
    JOIN public.ordres_fabrication o ON o.id = op.of_id
    JOIN public.centres_frais cf ON cf.id = op.cf_id
    CROSS JOIN bounds b
    LEFT JOIN public.planning_events e ON e.of_operation_id = op.id
      AND e.kind = 'OF_OPERATION' AND e.archived_at IS NULL AND e.status <> 'CANCELLED'
      AND e.start_ts < b.ends AND e.end_ts > b.starts
    WHERE (upper(btrim(cf.type_cf)) IN ('ASSEMBLAGE', 'MONTAGE') OR upper(cf.code) IN ('CF-ASSEMBLAGE', 'CF-MONTAGE'))
      AND op.status::text <> 'CANCELLED' AND o.statut <> 'ANNULE'
      AND (e.id IS NOT NULL OR (
        o.statut NOT IN ('TERMINE','CLOTURE') AND op.ended_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.planning_events future WHERE future.of_operation_id = op.id
            AND future.kind = 'OF_OPERATION' AND future.archived_at IS NULL AND future.status <> 'CANCELLED'
        )
      ))
      AND (op.revision_id IS NULL OR EXISTS (
        SELECT 1 FROM public.of_revisions r WHERE r.id = op.revision_id AND r.statut = 'ACTIVE'
      ))
      AND NOT EXISTS (
        SELECT 1 FROM public.production_consolidation_allocations a WHERE a.source_of_id = o.id AND a.state = 'ACTIVE'
      )
    ORDER BY e.start_ts, o.numero, op.phase, e.id`, [week],
  );
  return operations.rows;
}

export async function writeAssemblyWeek(input: SaveAssemblyWeek, actorId: number | null) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [teamKey]);
    const current = await client.query<{ key: string; value_json: unknown; version: string }>(
      settingsQuery,
      [[teamKey, weekKey(input.week)]],
    );
    const team = current.rows.find((row) => row.key === teamKey);
    const week = current.rows.find((row) => row.key === weekKey(input.week));
    if ((team?.version ?? null) !== input.teamVersion || (week?.version ?? null) !== input.weekVersion) {
      throw new HttpError(409, "ASSEMBLY_PLANNING_CHANGED", "Le planning Assemblage a changé. Actualisez la vue puis reprenez la saisie.");
    }
    for (const [key, data] of [[teamKey, input.team], [weekKey(input.week), input.presence]] as const) {
      if (key === teamKey && JSON.stringify(team?.value_json) === JSON.stringify(input.team)) continue;
      await client.query(
        `INSERT INTO public.erp_settings (key, value_json, created_by, updated_by)
         VALUES ($1, $2::jsonb, $3, $3)
         ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(data), actorId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
