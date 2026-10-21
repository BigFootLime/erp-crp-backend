import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { AuditContext } from "./planning.repository";
import { resolvePlanningClientColor } from "../domain/planning-client-color";

export async function repoListPlanningClientColors(): Promise<Record<string, string>> {
  const result = await pool.query<{ client_id: string; company_name: string | null; planning_color_hex: string | null }>(
    "SELECT client_id::text, company_name, planning_color_hex FROM public.clients"
  );
  return Object.fromEntries(result.rows.map(row => [`id:${row.client_id}`, resolvePlanningClientColor(row.client_id, row.company_name, row.planning_color_hex)!]));
}

export async function repoSetPlanningClientColor(clientId: string, color: string | null, audit: AuditContext) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const found = await tx.query<{ company_name: string | null; planning_color_hex: string | null }>(
      "SELECT company_name, planning_color_hex FROM public.clients WHERE client_id = $1 FOR UPDATE", [clientId]
    );
    const before = found.rows[0];
    if (!before) throw new HttpError(404, "PLANNING_CLIENT_NOT_FOUND", "Client introuvable.");
    await tx.query("UPDATE public.clients SET planning_color_hex = $2 WHERE client_id = $1", [clientId, color]);
    const logged = await repoInsertAuditLog({ user_id: audit.user_id, tx,
      ip: audit.ip, user_agent: audit.user_agent, device_type: audit.device_type, os: audit.os, browser: audit.browser,
      body: { event_type: "ACTION", action: "planning.client-color.update", page_key: audit.page_key,
        entity_type: "clients", entity_id: clientId, path: audit.path, client_session_id: audit.client_session_id,
        details: { before: before.planning_color_hex, after: color } },
    });
    if (!logged?.id) throw new Error("PLANNING_CLIENT_COLOR_AUDIT_FAILED");
    await tx.query("COMMIT");
    return { client_id: clientId, color: resolvePlanningClientColor(clientId, before.company_name, color)! };
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}
