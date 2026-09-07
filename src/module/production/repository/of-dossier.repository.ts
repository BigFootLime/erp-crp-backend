import {createHash} from "node:crypto";
import type {PoolClient} from "pg";
import pool from "../../../config/database";
import {HttpError} from "../../../utils/httpError";
import {withRealtimeOutboxTransaction} from "../../../shared/realtime/realtime-outbox-transaction";
import {evaluateDossier,type DossierFacts,type DossierOperation} from "../domain/of-dossier";
import {evaluateOfPreparation,preparationAudit} from "./production-preparation.repository";
import type {AuditContext} from "./production.repository";

export type DossierDb=Pick<PoolClient,"query">;
export async function materialWorkflowEnabled(tx:DossierDb=pool) {
  return (await tx.query<{enabled:boolean}>("SELECT enabled FROM public.app_feature_flags WHERE key='PRODUCTION_MATERIAL_WORKFLOW'")).rows[0]?.enabled===true;
}
export async function readOfDossierTx(tx:DossierDb,id:number) {
  const row=(await tx.query(`SELECT o.id::bigint::int,o.statut::text AS status,o.technical_readiness,o.technical_snapshot_sha256,
    o.piece_technique_version_id::text,o.quantite_lancee::float8,o.updated_at::text,o.numero,
    CASE WHEN cc.order_type='INTERNE' THEN NULL ELSE cl.delai_client::text END AS customer_due,
    CASE WHEN cc.order_type='INTERNE' THEN COALESCE(cl.delai_interne,cl.delai_client)::text ELSE cl.delai_interne::text END AS internal_due,o.date_lancement_reelle::text,o.date_fin_reelle::text
    FROM public.ordres_fabrication o LEFT JOIN public.commande_client cc ON cc.id=o.commande_id
    LEFT JOIN public.commande_ligne cl ON cl.id=o.commande_ligne_id WHERE o.id=$1`,[id])).rows[0];
  if(!row) throw new HttpError(404,"OF_NOT_FOUND","Ordre de fabrication introuvable.");
  const operations=(await tx.query<DossierOperation>(`SELECT p.id::text,p.phase,p.designation AS label,p.status::text,
    p.tp::float8 AS setup,p.tf_unit::float8 AS unit,p.qte::float8 AS base,p.coef::float8 AS coefficient,
    e.count>0 AS planned,e.start_ts::text AS start,e.end_ts::text AS end,e.resource
    FROM public.of_operations p LEFT JOIN LATERAL(SELECT count(*) AS count,min(e.start_ts) AS start_ts,max(e.end_ts) AS end_ts,
      string_agg(DISTINCT COALESCE(m.name,s.label),' · ') AS resource FROM public.planning_events e
      LEFT JOIN public.machines m ON m.id=e.machine_id LEFT JOIN public.postes s ON s.id=e.poste_id
      WHERE e.of_operation_id=p.id AND e.archived_at IS NULL AND e.status<>'CANCELLED' AND e.end_ts>e.start_ts
      AND(e.machine_id IS NOT NULL OR e.poste_id IS NOT NULL)) e ON true
    WHERE p.of_id=$1 AND(p.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=p.revision_id AND r.statut='ACTIVE'))
    ORDER BY p.phase,p.id`,[id])).rows;
  const validation=(await tx.query(`SELECT id::text,source_hash,decided_at::text,decided_by,invalidated_at::text,invalidation_reason
    FROM public.of_dossier_validations WHERE of_id=$1 ORDER BY decided_at DESC,id DESC LIMIT 1`,[id])).rows[0]??null;
  const facts:DossierFacts={id,status:row.status,technicalReadiness:row.technical_readiness,technicalHash:row.technical_snapshot_sha256,
    revision:row.piece_technique_version_id,quantity:row.quantite_lancee,operations};
  const dossier=evaluateDossier(facts,validation);
  const ends=operations.flatMap(o=>o.end?[o.end]:[]).sort((a,b)=>Date.parse(a)-Date.parse(b));
  const starts=operations.flatMap(o=>o.start?[o.start]:[]).sort((a,b)=>Date.parse(a)-Date.parse(b));
  const forecast=(await tx.query<{end:string|null}>(`SELECT max(forecast_end)::text AS end FROM public.planning_tasks t
    JOIN public.of_operations p ON p.id=t.operation_id WHERE p.of_id=$1`,[id])).rows[0]?.end??null;
  const version=createHash("sha256").update(JSON.stringify([row.updated_at,dossier.sourceHash,operations.map(o=>[o.id,o.start,o.end,o.status]),validation])).digest("hex");
  return {enabled:true,ofId:id,number:row.numero,version,executionStatus:row.status,technicalReadiness:row.technical_readiness,
    quantity:row.quantite_lancee,...dossier,validation,operations,
    dates:{customerDue:row.customer_due,internalDue:row.internal_due,committedStart:starts[0]??null,committedEnd:ends.at(-1)??null,
      forecastEnd:forecast,actualStart:row.date_lancement_reelle,actualEnd:row.date_fin_reelle}};
}
export async function repoOfDossier(id:number) {
  const tx=await pool.connect();
  try {
    await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result=await materialWorkflowEnabled(tx)?await readOfDossierTx(tx,id):{enabled:false as const};
    await tx.query("COMMIT");
    return result;
  } catch(error) {await tx.query("ROLLBACK");throw error;} finally {tx.release();}
}
export async function repoCompleteOfDossier(id:number,body:{expectedVersion:string;idempotencyKey:string},audit:AuditContext) {
  return withRealtimeOutboxTransaction(await pool.connect(),async tx=>{
    // Same lock order as central planning: planning revision before the OF.
    await tx.query("SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE");
    await tx.query("SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE",[id]);
    if(!await materialWorkflowEnabled(tx)) throw new HttpError(409,"MATERIAL_WORKFLOW_DISABLED","Le parcours matière n’est pas activé.");
    const payloadHash=createHash("sha256").update(JSON.stringify([id,body.expectedVersion])).digest("hex");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[body.idempotencyKey]);
    const replay=(await tx.query("SELECT * FROM public.of_material_commands WHERE idempotency_key=$1::uuid",[body.idempotencyKey])).rows[0];
    if(replay){
      if(replay.actor_id!==audit.user_id||Number(replay.of_id)!==id||replay.command_type!=="COMPLETE"||replay.payload_hash!==payloadHash)
        throw new HttpError(409,"IDEMPOTENCY_KEY_REUSED","Cette action a déjà été utilisée avec un autre contenu.");
      return replay.response;
    }
    const current=await readOfDossierTx(tx,id);
    if(current.version!==body.expectedVersion) throw new HttpError(409,"DOSSIER_CHANGED","Le dossier a changé. Relis ses conséquences avant de valider.");
    if(!current.canComplete) throw new HttpError(409,"DOSSIER_INCOMPLETE","Le dossier et toutes ses opérations doivent être préparés et planifiés.",{blockers:current.blockers});
    const preparation=await evaluateOfPreparation(tx,id);
    if(!preparation.ready) throw new HttpError(409,"DOSSIER_TECHNICAL_CHANGED","La préparation technique doit être revue.",{items:preparation.items});
    if(current.status!=="COMPLETE"){
      await tx.query("UPDATE public.of_dossier_validations SET invalidated_at=COALESCE(invalidated_at,now()),invalidation_reason=COALESCE(invalidation_reason,'Nouvelle validation du dossier.') WHERE of_id=$1 AND invalidated_at IS NULL",[id]);
      await tx.query(`INSERT INTO public.of_dossier_validations(of_id,source_hash,planning_revision,evidence,decided_by)
        SELECT $1,$2,revision,$3::jsonb,$4 FROM public.planning_central_settings WHERE singleton`,[id,current.sourceHash,JSON.stringify({planning:current.planning,operations:current.operations,preparationHash:preparation.source_hash}),audit.user_id]);
      // Never changes execution status or actual dates.
      await preparationAudit(tx,audit,id,"production.of.dossier.complete",{sourceHash:current.sourceHash,operations:current.planning.total});
    }
    const response=await readOfDossierTx(tx,id);
    await tx.query("INSERT INTO public.of_material_commands(idempotency_key,actor_id,of_id,command_type,payload_hash,response) VALUES($1::uuid,$2,$3,'COMPLETE',$4,$5::jsonb)",[body.idempotencyKey,audit.user_id,id,payloadHash,JSON.stringify(response)]);
    return response;
  });
}
