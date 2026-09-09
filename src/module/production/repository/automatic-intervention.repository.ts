import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";

/** Called inside the new intervention transaction. Failure later rolls back
 * both the released intervention and the requested new start. */
export async function releasePreviousIntervention(
  tx: PoolClient,
  operatorId: number,
  currentId: string | null,
  confirmedId?: string,
) {
  await tx.query("SELECT pg_advisory_xact_lock(1038,$1::int)", [operatorId]);
  const previous = (
    await tx.query<{
      id: string;
      machine_id: string | null;
      activity_code: string;
      operation_id: string | null;
    }>(
      `SELECT id::text,machine_id::text,activity_code,operation_id::text FROM public.production_pointages
     WHERE operator_user_id=$1 AND status='RUNNING' AND activity_code IS DISTINCT FROM 'AUTO_MACHINE'
       AND ($2::uuid IS NULL OR id<>$2::uuid) FOR UPDATE`,
      [operatorId, currentId],
    )
  ).rows[0];
  if (!previous) {
    if (confirmedId)
      throw new HttpError(
        409,
        "INTERVENTION_CHANGED",
        "L’intervention précédente a changé. Actualisez les postes.",
      );
    return;
  }
  if (previous.id !== confirmedId)
    throw new HttpError(
      409,
      "PERSONAL_INTERVENTION_ACTIVE",
      "Une intervention personnelle est en cours. Confirmez son passage en automatique.",
      { execution_id: previous.id, machine_id: previous.machine_id },
    );
  if (!previous.machine_id || previous.activity_code !== "PRODUCTION")
    throw new HttpError(
      409,
      "INTERVENTION_NOT_AUTOMATIC",
      "Terminez ou mettez en pause cette intervention sur son poste avant de changer de machine.",
    );
  await tx.query(
    `UPDATE public.production_pointages SET status='DONE',end_ts=now(),updated_at=now(),updated_by=$2 WHERE id=$1`,
    [previous.id, operatorId],
  );
  const next = (
    await tx.query<{ id: string }>(
      `INSERT INTO public.production_pointages(of_id,operation_id,affaire_id,piece_technique_id,
    machine_id,poste_id,operator_user_id,time_type,activity_code,start_ts,status,session_id,previous_segment_id,segment_index,source,context_snapshot,created_by,updated_by)
    SELECT of_id,operation_id,affaire_id,piece_technique_id,machine_id,poste_id,operator_user_id,'MACHINE','AUTO_MACHINE',now(),'RUNNING',
    COALESCE(session_id,id),id,segment_index+1,'CANONICAL',context_snapshot,$2,$2 FROM public.production_pointages WHERE id=$1 RETURNING id`,
      [previous.id, operatorId],
    )
  ).rows[0];
  await tx.query(
    `INSERT INTO public.production_pointage_events(pointage_id,event_type,user_id,old_values,new_values,note)
    VALUES($1,'CHANGE_ACTIVITY',$3,$4::jsonb,$5::jsonb,'Intervention libérée depuis une autre machine'),
    ($2,'START',$3,NULL,$5::jsonb,'Marche automatique conservée')`,
    [
      previous.id,
      next.id,
      operatorId,
      JSON.stringify({ activity_code: "PRODUCTION" }),
      JSON.stringify({
        activity_code: "AUTO_MACHINE",
        previous_segment_id: previous.id,
      }),
    ],
  );
  if (previous.operation_id)
    await tx.query(
      "SELECT public.fn_production_recompute_operation_real_time($1::uuid)",
      [previous.operation_id],
    );
}
