import type { PoolClient } from "pg";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import {
  getDocumentStoragePath,
  resolveCerpStoragePath,
} from "../../../utils/cerpStorage";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
type Queryer = Pick<PoolClient, "query">;
export const MAINTENANCE_EVIDENCE_SQL = `SELECT id::text,machine_id::text,title,document_type,revision,sha256,mime_type,size_bytes::float8,authored_at::text FROM public.production_machine_documents
 WHERE machine_id=$1::uuid AND removed_at IS NULL AND storage_path IS NOT NULL AND btrim(storage_path)<>''
 AND document_type IN ('MAINTENANCE','PHOTO','CERTIFICATE') AND sha256~'^[a-f0-9]{64}$' AND size_bytes BETWEEN 1 AND 10485760`;
export const MAINTENANCE_AUTHORIZATIONS_SQL = `SELECT a.id::text,a.plan_id::text,a.user_id,a.revision,a.enabled,a.valid_from::text,a.valid_to::text,a.reason,a.evidence_snapshot AS evidence,a.created_by,a.created_at::text,u.username,
 concat_ws(' ',NULLIF(u.name,''),NULLIF(u.surname,'')) AS operator_name,
 NOT EXISTS(SELECT 1 FROM public.production_maintenance_authorizations x WHERE x.plan_id=a.plan_id AND x.user_id=a.user_id AND x.revision>a.revision) AS current
 FROM public.production_maintenance_authorizations a JOIN public.production_machine_maintenance_plans p ON p.id=a.plan_id JOIN public.users u ON u.id=a.user_id WHERE p.machine_id=$1::uuid ORDER BY a.created_at DESC LIMIT 500`;
export const MAINTENANCE_RECEIPTS_SQL = `SELECT r.id::text,r.event_id::text,r.plan_id::text,r.authorization_id::text,r.plan_snapshot,r.evidence_snapshot AS evidence,r.results,r.signature_snapshot AS signature,
 r.counter_value::float8,r.next_due_at::text,r.next_due_counter::float8,r.notes,r.created_by,r.created_at::text
 FROM public.production_maintenance_receipts r WHERE r.machine_id=$1::uuid ORDER BY r.created_at DESC LIMIT 200`;
export const MAINTENANCE_HOLDS_SQL = `SELECT h.id::text,h.machine_id::text,h.receipt_id::text,h.reason,h.created_by,h.created_at::text,h.resolved_at::text,h.resolved_by,h.resolution_reason,h.resolution_evidence FROM public.production_maintenance_holds h WHERE h.machine_id=$1::uuid ORDER BY h.created_at DESC LIMIT 500`;
export async function maintenanceEvidenceTx(
  tx: Queryer,
  machineId: string,
  documentId: string,
) {
  const row = (
    await tx.query(MAINTENANCE_EVIDENCE_SQL + " AND id=$2::uuid FOR SHARE", [
      machineId,
      documentId,
    ])
  ).rows[0];
  if (!row)
    throw new HttpError(
      422,
      "MAINTENANCE_EVIDENCE_REQUIRED",
      "Choisissez un fichier de maintenance, photo ou certificat réellement déposé pour cette machine (10 Mo maximum).",
    );
  const stored = (
    await tx.query<{ storage_path: string }>(
      "SELECT storage_path FROM public.production_machine_documents WHERE id=$1::uuid FOR SHARE",
      [documentId],
    )
  ).rows[0];
  try {
    const filePath = resolveCerpStoragePath(
      stored.storage_path,
      getDocumentStoragePath("machines"),
    );
    const info = await fs.stat(filePath);
    if (!info.isFile() || info.size !== row.size_bytes) throw new Error("size");
    const bytes = await fs.readFile(filePath);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== row.sha256)
      throw new Error("hash");
  } catch {
    throw new HttpError(
      422,
      "MAINTENANCE_EVIDENCE_UNAVAILABLE",
      "Le fichier justificatif est indisponible ou son intégrité ne correspond plus au dépôt. Déposez un justificatif valide.",
    );
  }
  return row;
}
export async function repoMaintenanceWorkspace(
  machineId: string,
  actor: number,
  canManage: boolean,
) {
  if (
    !(
      await pool.query("SELECT id FROM public.machines WHERE id=$1::uuid", [
        machineId,
      ])
    ).rows.length
  )
    throw new HttpError(404, "MACHINE_NOT_FOUND", "Machine introuvable.");
  const [plans, authorizations, receipts, holds, readings, evidence, users] =
    await Promise.all([
      pool.query(
        `SELECT id::text,title,status,frequency_days,frequency_counter::float8,counter_unit,next_due_at::text,responsible_user_id,checklist,version,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,counter_value::float8,next_due_counter::float8,document_id::text,notes,source FROM public.production_machine_maintenance_plans WHERE machine_id=$1::uuid AND archived_at IS NULL ORDER BY next_due_at NULLS LAST,title`,
        [machineId],
      ),
      pool.query(MAINTENANCE_AUTHORIZATIONS_SQL, [machineId]),
      pool.query(MAINTENANCE_RECEIPTS_SQL, [machineId]),
      pool.query(MAINTENANCE_HOLDS_SQL, [machineId]),
      pool.query(
        `SELECT r.id::text,r.plan_id::text,r.value::float8,r.reset,r.reason,r.created_by,r.created_at::text FROM public.production_maintenance_counter_readings r WHERE r.machine_id=$1::uuid ORDER BY r.created_at DESC LIMIT 200`,
        [machineId],
      ),
      pool.query(
        MAINTENANCE_EVIDENCE_SQL + " ORDER BY retrieved_at DESC LIMIT 100",
        [machineId],
      ),
      canManage
        ? pool.query(
            `SELECT id::int,username,concat_ws(' ',NULLIF(name,''),NULLIF(surname,'')) AS name FROM public.users WHERE COALESCE(NULLIF(lower(trim(status)),''),'active') NOT IN ('inactive','blocked','suspended') ORDER BY username LIMIT 500`,
          )
        : Promise.resolve({ rows: [] }),
    ]);
  return {
    actor_id: actor,
    can_manage: canManage,
    plans: plans.rows,
    authorizations: authorizations.rows,
    receipts: receipts.rows,
    holds: holds.rows,
    counter_readings: readings.rows,
    evidence: evidence.rows,
    users: users.rows,
  };
}
export async function assertMaintenanceMachineUnblockedTx(
  tx: Queryer,
  machineId: string,
) {
  if (
    (
      await tx.query(
        "SELECT id FROM public.production_maintenance_holds WHERE machine_id=$1::uuid AND resolved_at IS NULL LIMIT 1",
        [machineId],
      )
    ).rows.length
  )
    throw new HttpError(
      409,
      "MAINTENANCE_MACHINE_BLOCKED",
      "Une anomalie de maintenance impose l’arrêt de cette machine. Faites enregistrer sa remise en service.",
      { machine_id: machineId },
    );
}
