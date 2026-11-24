import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import {
  RESOURCE_WORKING_HOURS_KEY,
  STANDARD_POSTE_HOURS_TYPES,
  resourceWorkingHoursSchema,
  type UpdatePosteHours,
} from "../domain/resource-working-hours";

async function readResourceHours(tx: Pick<PoolClient, "query">, forUpdate = false) {
  const { rows: [row] } = await tx.query<{ value_json: unknown; updated_at: string }>(
    `SELECT value_json, updated_at::text FROM public.erp_settings WHERE key=$1 ${forUpdate ? "FOR UPDATE" : ""}`,
    [RESOURCE_WORKING_HOURS_KEY],
  );
  const hours = resourceWorkingHoursSchema.safeParse(row?.value_json ?? {});
  if (!hours.success) {
    throw new HttpError(409, "PLANNING_RESOURCE_HOURS_INVALID", "Les horaires des ressources du planning sont invalides.");
  }
  return { value: hours.data, updatedAt: row?.updated_at ?? null };
}

export async function readPosteHours() {
  const { value, updatedAt } = await readResourceHours(pool);
  return { postes: value.postes ?? null, expected_updated_at: updatedAt };
}

export async function savePosteHours(input: UpdatePosteHours, userId: number) {
  return withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [RESOURCE_WORKING_HOURS_KEY]);
    const settings = await tx.query("SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE");
    if (!settings.rowCount) {
      throw new HttpError(503, "PLANNING_NOT_CONFIGURED", "Le planning central n’est pas configuré.");
    }
    const current = await readResourceHours(tx, true);
    if (current.updatedAt !== input.expected_updated_at) {
      throw new HttpError(409, "PLANNING_RESOURCE_HOURS_CHANGED", "Les horaires ont changé. Rechargez-les avant d’enregistrer.");
    }
    const previous = current.value.postes;
    if (previous?.hours.start === input.hours.start && previous.hours.end === input.hours.end) {
      return { postes: previous, expected_updated_at: current.updatedAt };
    }
    const postes = {
      categories: previous?.categories ?? [...STANDARD_POSTE_HOURS_TYPES],
      hours: input.hours,
    };
    const { rows: [saved] } = await tx.query<{ updated_at: string }>(
      `INSERT INTO public.erp_settings(key, value_json, created_by, updated_by)
       VALUES ($1, $2::jsonb, $3, $3)
       ON CONFLICT (key) DO UPDATE SET value_json=EXCLUDED.value_json, updated_by=EXCLUDED.updated_by,
         updated_at=clock_timestamp()
       RETURNING updated_at::text`,
      [RESOURCE_WORKING_HOURS_KEY, JSON.stringify({ ...current.value, postes }), userId],
    );
    await tx.query(`WITH revised AS (
      UPDATE public.planning_central_settings SET revision=revision+1,updated_at=clock_timestamp()
      WHERE singleton RETURNING revision
    )
    INSERT INTO public.planning_recalculation_jobs(entity_table,entity_id,source_revision)
    SELECT 'erp_settings',$1,revision FROM revised`, [RESOURCE_WORKING_HOURS_KEY]);
    await repoInsertAuditLog({
      tx, user_id: userId, ip: null, user_agent: null, device_type: null, os: null, browser: null,
      body: {
        event_type: "ACTION", action: "ERP_WORKSTATION_HOURS_SAVED", page_key: "erp-settings",
        entity_type: "erp_setting", entity_id: RESOURCE_WORKING_HOURS_KEY,
        path: "/api/v1/admin/onboarding/workstations/hours",
        details: { categories: postes.categories, previous_hours: previous?.hours ?? null, hours: postes.hours },
      },
    });
    return { postes, expected_updated_at: saved.updated_at };
  });
}
