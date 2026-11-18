import type { PoolClient } from "pg";

import pool from "../../config/database";
import { repoInsertAuditLog } from "../../module/audit-logs/repository/audit-logs.repository";
import { withRealtimeOutboxTransaction } from "../realtime/realtime-outbox-transaction";
import { isTestEmailEnvironment } from "./test-email-routing";

export const COMMERCIAL_EMAIL_SETTING = "commerce.outbound_email";

export async function readCommercialEmailSetting(queryer: Pick<PoolClient, "query"> = pool) {
  const { rows: [row] } = await queryer.query<{
    value_json: { enabled?: unknown } | null;
    updated_at: string;
  }>(
    "SELECT value_json, updated_at::text FROM public.erp_settings WHERE key = $1",
    [COMMERCIAL_EMAIL_SETTING],
  );

  return {
    key: COMMERCIAL_EMAIL_SETTING,
    // Preserve existing delivery behavior for databases with no explicit setting.
    value_json: { enabled: row ? row.value_json?.enabled === true : true },
    value_text: null,
    updated_at: row?.updated_at ?? null,
    mode: isTestEmailEnvironment() ? "test" : "production",
  };
}

export async function saveCommercialEmailSetting(enabled: boolean, actor: number) {
  return withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [COMMERCIAL_EMAIL_SETTING]);
    const previous = await readCommercialEmailSetting(tx);
    if (previous.updated_at && previous.value_json.enabled === enabled) return previous;

    const { rows: [row] } = await tx.query<{ updated_at: string }>(
      `INSERT INTO public.erp_settings(key, value_json, created_by, updated_by)
       VALUES ($1, $2::jsonb, $3, $3)
       ON CONFLICT (key) DO UPDATE SET
         value_json = EXCLUDED.value_json, value_text = NULL,
         updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING updated_at::text`,
      [COMMERCIAL_EMAIL_SETTING, JSON.stringify({ enabled }), actor],
    );
    await repoInsertAuditLog({
      user_id: actor,
      body: {
        event_type: "ACTION",
        action: "ADMIN_ERP_SETTING_UPDATED",
        page_key: "erp-settings",
        entity_type: "erp_setting",
        entity_id: COMMERCIAL_EMAIL_SETTING,
        path: `/api/v1/admin/erp-settings/${COMMERCIAL_EMAIL_SETTING}`,
        details: { previous_enabled: previous.value_json.enabled, enabled },
      },
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      tx,
    });
    return { ...previous, value_json: { enabled }, updated_at: row.updated_at };
  });
}
