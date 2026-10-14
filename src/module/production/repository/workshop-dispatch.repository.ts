import pool from "../../../config/database";
import type { DbQueryer } from "./of-versioning.repository";
export type WorkshopDispatchJob = {
  id: string; of_id: number; number: string; revision_rank: number; technical_sha256: string;
  state: "PENDING" | "CLAIMED" | "REVIEW" | "SPOOLED"; claimed_by: number | null; device_id: string | null;
  print_intent_id: string | null; folder_id: string | null; created_at: string;
};
const select = `SELECT j.id::text,j.of_id::int,o.numero AS number,j.revision_rank,j.technical_sha256,j.state,j.claimed_by,
  j.device_id::text,j.print_intent_id::text,j.folder_id::text,j.created_at::text
  FROM public.of_workshop_print_jobs j JOIN public.ordres_fabrication o ON o.id=j.of_id`;
export async function readWorkshopDispatchJob(id: string, tx: DbQueryer = pool, lock = false) {
  return (await tx.query<WorkshopDispatchJob>(`${select} WHERE j.id=$1::uuid${lock ? " FOR UPDATE OF j" : ""}`, [id])).rows[0] ?? null;
}
export async function listWorkshopDispatchJobs(actorId: number, deviceId: string) {
  return (await pool.query<WorkshopDispatchJob>(`${select} WHERE j.state<>'SPOOLED' AND
    (j.claimed_by IS NULL OR (j.claimed_by=$1 AND j.device_id=$2::uuid)) AND o.statut::text NOT IN('ANNULE','ARCHIVE','TERMINE','CLOTURE')
    AND j.technical_sha256=o.technical_snapshot_sha256 AND j.revision_rank=COALESCE((SELECT r.revision_rank FROM public.of_revisions r
      WHERE r.of_id=o.id AND r.statut='ACTIVE'),0) ORDER BY j.created_at,j.id LIMIT 50`, [actorId, deviceId])).rows;
}
export async function claimWorkshopDispatch(tx: DbQueryer, id: string, actorId: number, deviceId: string) {
  await tx.query(`UPDATE public.of_workshop_print_jobs SET claimed_by=$2,device_id=$3::uuid,claimed_at=clock_timestamp(),state='CLAIMED'
    WHERE id=$1::uuid AND claimed_by IS NULL`, [id, actorId, deviceId]);
}
export async function bindWorkshopDispatch(tx: DbQueryer, id: string, intentId: string, folderId: string) {
  await tx.query(`UPDATE public.of_workshop_print_jobs SET print_intent_id=$2::uuid,folder_id=$3::uuid
    WHERE id=$1::uuid AND print_intent_id IS NULL`, [id, intentId, folderId]);
}
export async function acknowledgeWorkshopDispatch(tx: DbQueryer, job: WorkshopDispatchJob, actorId: number, deviceId: string, outcome: "SPOOLED" | "FAILED" | "UNCERTAIN") {
  const inserted = await tx.query(`INSERT INTO public.of_workshop_print_receipts(job_id,intent_id,device_id,actor_id,outcome)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5) ON CONFLICT DO NOTHING RETURNING id`, [job.id, job.print_intent_id, deviceId, actorId, outcome]);
  if (job.state !== "SPOOLED") await tx.query("UPDATE public.of_workshop_print_jobs SET state=$2 WHERE id=$1::uuid", [job.id, outcome === "SPOOLED" ? "SPOOLED" : "REVIEW"]);
  return Boolean(inserted.rowCount);
}
