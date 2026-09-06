import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withPlanningCommand as command } from "../repository/planning-command.repository";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { schedule } from "../domain/central-scheduler";
import { centralCanonicalJson } from "../domain/central-canonical-json";
import { readCentralDependencies, readCentralSettings, readCentralSnapshot } from "../repository/planning-central.repository";
import { assertOperationResourceCompatible, assertResourceSchedulable, repoArchivePlanningEvent, type AuditContext } from "../repository/planning.repository";
import type { CentralSimulationInput, CentralUnplanInput } from "../validators/planning-central.validators";
import type { CentralSnapshot, ScheduleResult } from "../types/planning-central.types";
import { PROGRAMMING_ASSIGNEE_PREDICATE_SQL } from "../../production/repository/production-preparation.repository";

const levels: CentralSnapshot["activation"][] = ["OBSERVE","READ","SIMULATE","COMMIT","EXECUTE","LEARN"];
export async function unplanCentral(input: CentralUnplanInput, audit: AuditContext, key: string) {
  return command(audit,key,"unplan",input,async tx => {
    await tx.query("SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE");
    const settings=await readCentralSettings(tx);
    assertCentralActivation(settings.activation,"COMMIT");
    if(settings.revision!==input.revision) throw stale();
    const snapshot=await readCentralSnapshot({from:input.from,to:input.to,limit:10000,includeTaskIds:input.tasks.map(t=>t.id)},tx);
    const selected=input.tasks.map(request => {
      const task=snapshot.tasks.find(t=>t.id===request.id);
      if(!task || task.version!==request.expectedVersion) throw stale();
      if(!task.committed || task.locked || task.commitment!=="COMMITTED" || task.actual)
        throw new HttpError(409,"PLANNING_UNPLAN_LOCKED","Une opération commencée, terminée ou verrouillée ne peut pas être retirée du planning.");
      if(task.source!=="OPERATION" && !task.id.startsWith("version-program:"))
        throw new HttpError(409,"PLANNING_UNPLAN_UNSUPPORTED","Utilisez le parcours historique pour cette programmation.");
      return task;
    });
    for(const task of selected) {
      if(task.source==="OPERATION") {
        const events=await tx.query<{id:string;status:string}>("SELECT id::text,status::text FROM public.planning_events WHERE of_operation_id=$1::uuid AND archived_at IS NULL AND status<>'CANCELLED' FOR UPDATE",[task.operationId]);
        if(!events.rows.length || events.rows.some(event=>event.status!=="PLANNED"))
          throw new HttpError(409,"PLANNING_UNPLAN_LOCKED","Un créneau commencé ou terminé ne peut pas être retiré.");
        for(const event of events.rows) await repoArchivePlanningEvent({id:event.id,audit,tx});
      }
      await tx.query("UPDATE public.planning_tasks SET committed_start=NULL,committed_end=NULL,forecast_start=NULL,forecast_end=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1",[task.id]);
    }
    // Programming-only changes must advance the same revision as machine events.
    await tx.query("UPDATE public.planning_central_settings SET revision=revision+1,updated_at=clock_timestamp() WHERE singleton");
    const ids=selected.map(t=>t.id), affected=new Set(ids);
    const dependencies=await readCentralDependencies(tx);
    let grew=true;
    while(grew) { grew=false; for(const d of dependencies) if(affected.has(d.predecessorId) && !affected.has(d.successorId)) {affected.add(d.successorId);grew=true;} }
    await tx.query("INSERT INTO public.planning_recalculation_jobs(entity_table,entity_id,source_revision) SELECT 'planning_tasks',unnest($1::text[]),revision FROM public.planning_central_settings WHERE singleton",[[...affected]]);
    await repoInsertAuditLog({user_id:audit.user_id,tx,ip:audit.ip,user_agent:audit.user_agent,device_type:audit.device_type,os:audit.os,browser:audit.browser,
      body:{event_type:"ACTION",action:"planning.central.unplan",page_key:audit.page_key,entity_type:"planning_tasks",entity_id:ids[0],path:audit.path,client_session_id:audit.client_session_id,
        details:{removed:ids,previous:selected.map(t=>({id:t.id,committed:t.committed})),affected:[...affected]}}});
    return {revision:(await readCentralSettings(tx)).revision,removed:ids,affected:[...affected]};
  });
}
export function assertCentralActivation(actual: CentralSnapshot["activation"], required: CentralSnapshot["activation"]) {
  if (levels.indexOf(actual) < levels.indexOf(required))
    throw new HttpError(409,"PLANNING_ACTIVATION_REQUIRED","Cette étape du planning central n'est pas encore activée.");
}
function stale() { return new HttpError(409,"PLANNING_SIMULATION_OBSOLETE",
  "Les données ont changé. Recalculez la simulation avant de l'appliquer.",{recalculate:true}); }
async function simulationSnapshot(input:CentralSimulationInput,tx:PoolClient) {
  const dependencies=await readCentralDependencies(tx),included=new Set(input.changes.map(change=>change.taskId));
  let grew=true;
  while(grew) {
    grew=false;
    for(const dependency of dependencies) if(included.has(dependency.predecessorId)||included.has(dependency.successorId)) {
      for(const id of [dependency.predecessorId,dependency.successorId]) if(!included.has(id)) {included.add(id);grew=true;}
    }
    if(included.size>10000)throw new HttpError(422,"PLANNING_CHAIN_TOO_DENSE","Cette chaîne dépasse la capacité de simulation. Planifiez-la par groupes.");
  }
  return readCentralSnapshot({from:input.from,to:input.to,limit:10000,includeTaskIds:[...included]},tx);
}
export async function createCentralSimulation(input:CentralSimulationInput,audit:AuditContext,key:string) {
  return command(audit,key,"simulate",input,async tx=>{
    // A repeatable snapshot is ensured by the shared revision lock; legacy writers invalidate it too.
    await tx.query("SELECT revision FROM public.planning_central_settings WHERE singleton FOR SHARE");
    const snapshot=await simulationSnapshot(input,tx);
    assertCentralActivation(snapshot.activation,"SIMULATE");
    if(snapshot.revision!==input.revision)throw stale();
    if(snapshot.nextCursor)throw new HttpError(422,"PLANNING_WINDOW_TOO_DENSE","Réduisez la fenêtre de simulation.");
    for(const change of input.changes) {
      const task=snapshot.tasks.find(t=>t.id===change.taskId);
      if(!task || task.version!==change.expectedVersion)throw stale();
    }
    const result=schedule({tasks:snapshot.tasks,resources:snapshot.resources,dependencies:snapshot.dependencies,
      from:input.from,requested:input.changes});
    const {rows}=await tx.query<{id:string}>(`INSERT INTO public.planning_simulations(created_by,base_revision,request,result)
      VALUES($1,$2,$3::jsonb,$4::jsonb) RETURNING id::text`,[audit.user_id,snapshot.revision,JSON.stringify(input),JSON.stringify(result)]);
    return {id:rows[0].id,revision:snapshot.revision,result};
  });
}
export async function getCentralSimulation(id:string,audit:AuditContext) {
  const {rows}=await pool.query("SELECT id,base_revision::text AS revision,result,status,created_at FROM public.planning_simulations WHERE id=$1::uuid AND created_by=$2",
    [id,audit.user_id]);
  if(!rows[0])throw new HttpError(404,"PLANNING_SIMULATION_NOT_FOUND","Simulation introuvable.");
  return rows[0];
}
async function auditApplication(tx:PoolClient,audit:AuditContext,id:string,result:ScheduleResult) {
  await repoInsertAuditLog({user_id:audit.user_id,tx,ip:audit.ip,user_agent:audit.user_agent,device_type:audit.device_type,
    os:audit.os,browser:audit.browser,body:{event_type:"ACTION",action:"planning.central.apply",page_key:audit.page_key,
      entity_type:"planning_simulations",entity_id:id,path:audit.path,client_session_id:audit.client_session_id,
      details:{changes:result.changes}}});
}
export async function applyCentralSimulation(id:string,revision:string,audit:AuditContext,key:string) {
  return command(audit,key,"apply",{id,revision},async tx=>{
    const {rows:states}=await tx.query<{revision:string;activation:CentralSnapshot["activation"]}>(
      "SELECT revision::text,activation FROM public.planning_central_settings WHERE singleton FOR UPDATE");
    assertCentralActivation(states[0].activation,"COMMIT");
    const {rows}=await tx.query<{base_revision:string;request:CentralSimulationInput;result:ScheduleResult;status:string}>(
      "SELECT base_revision::text,request,result,status FROM public.planning_simulations WHERE id=$1::uuid AND created_by=$2 FOR UPDATE",
      [id,audit.user_id]);
    const simulation=rows[0];
    if(!simulation)throw new HttpError(404,"PLANNING_SIMULATION_NOT_FOUND","Simulation introuvable.");
    if(simulation.status!=="PREVIEW")throw new HttpError(409,"PLANNING_SIMULATION_ALREADY_USED","Cette simulation a déjà été traitée.");
    if(states[0].revision!==revision || simulation.base_revision!==revision)throw stale();
    if(!simulation.result.feasible)throw new HttpError(409,"PLANNING_SIMULATION_INFEASIBLE","Résolvez les conflits de la simulation.");
    const input=simulation.request;
    const current=await simulationSnapshot(input,tx);
    // Recompute from canonical state, never trust a client-supplied or outdated schedule result.
    const result=schedule({tasks:current.tasks,resources:current.resources,dependencies:current.dependencies,from:input.from,requested:input.changes});
    if(!result.feasible || centralCanonicalJson(result.changes)!==centralCanonicalJson(simulation.result.changes))throw stale();
    // Batch moves can exchange slots; exclusions are checked against the final transaction state.
    await tx.query("SET CONSTRAINTS planning_events_machine_no_overlap,planning_events_poste_no_overlap DEFERRED");
    for(const change of result.changes) {
      const task=current.tasks.find(t=>t.id===change.taskId)!;
      if(task.locked || task.commitment==="STARTED" || task.commitment==="DONE")throw stale();
      if(task.source==="DRAFT")throw new HttpError(409,"PLANNING_DRAFT_NOT_COMMITTABLE","Définissez les opérations avant d'engager la capacité.");
      if(task.source==="OPERATION") {
        const r=change.resourceIds[0],resource={machine_id:r.startsWith("machine:")?r.slice(8):null,poste_id:r.startsWith("poste:")?r.slice(6):null};
        if(change.resourceIds.length!==1 || (!resource.machine_id && !resource.poste_id))
          throw new HttpError(422,"PLANNING_RESOURCE_INVALID","Ressource d'opération incompatible.");
        await assertResourceSchedulable(tx,resource);
        await assertOperationResourceCompatible({tx,of_operation_id:task.operationId,resource});
        const lock=await tx.query("SELECT cc.ar_sent_at FROM public.ordres_fabrication o LEFT JOIN public.commande_client cc ON cc.id=o.commande_id WHERE o.id=$1 FOR UPDATE OF o",[task.ofId]);
        if(lock.rows[0]?.ar_sent_at)throw new HttpError(409,"PLANNING_LOCKED_AFTER_AR","Le dossier figé nécessite le parcours de révision de l'OF.");
        const existing=await tx.query<{id:string}>(`SELECT id FROM public.planning_events WHERE of_operation_id=$1::uuid
          AND archived_at IS NULL AND status<>'CANCELLED' FOR UPDATE`,[task.operationId]);
        if(existing.rows.length>1)throw new HttpError(409,"PLANNING_SPLIT_OPERATION","Cette opération possède plusieurs créneaux à rapprocher.");
        if(existing.rows[0]) await tx.query(`UPDATE public.planning_events SET start_ts=$2,end_ts=$3,machine_id=$4,poste_id=$5,
          updated_by=$6,updated_at=clock_timestamp() WHERE id=$1`,[existing.rows[0].id,change.after.start,change.after.end,resource.machine_id,resource.poste_id,audit.user_id]);
        else await tx.query(`INSERT INTO public.planning_events(id,kind,status,priority,of_id,of_operation_id,title,start_ts,end_ts,machine_id,poste_id,created_by,updated_by)
          VALUES(gen_random_uuid(),'OF_OPERATION','PLANNED','NORMAL',$1,$2,$3,$4,$5,$6,$7,$8,$8)`,
          [task.ofId,task.operationId,task.label,change.after.start,change.after.end,resource.machine_id,resource.poste_id,audit.user_id]);
      } else if(task.id.startsWith("version-program:")) {
        const person=change.resourceIds[0];
        if(!person?.startsWith("person:") || change.resourceIds.length!==1)throw new HttpError(422,"PLANNING_PROGRAMMER_REQUIRED","Sélectionnez un programmeur.");
        const eligible=await tx.query(`SELECT u.id FROM public.users u WHERE u.id=$1 AND ${PROGRAMMING_ASSIGNEE_PREDICATE_SQL} FOR SHARE OF u`,[Number(person.slice(7))]);
        if(!eligible.rowCount)throw new HttpError(422,"PROGRAMMER_REQUIRED","Sélectionnez un responsable actif habilité à la programmation.");
        const definition=await tx.query(`SELECT p.assignee_id,EXISTS(SELECT 1 FROM public.ordres_fabrication o
          WHERE o.piece_technique_version_id=p.piece_technique_version_id AND o.technical_snapshot_sha256 IS NOT NULL) AS frozen
          FROM public.piece_version_programming_tasks p WHERE p.id=$1::uuid FOR UPDATE OF p`,[task.programmingId]);
        if(definition.rows[0]?.frozen && Number(definition.rows[0].assignee_id)!==Number(person.slice(7)))
          throw new HttpError(409,"PROGRAMMING_DEFINITION_FROZEN","La réaffectation de cette définition figée nécessite sa révision technique.");
        await tx.query("UPDATE public.piece_version_programming_tasks SET assignee_id=$2,updated_at=clock_timestamp(),updated_by=$3 WHERE id=$1::uuid",
          [task.programmingId,Number(person.slice(7)),audit.user_id]);
        await tx.query("UPDATE public.planning_tasks SET committed_start=$2,committed_end=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
          [task.id,change.after.start,change.after.end]);
      } else throw new HttpError(409,"PLANNING_LEGACY_PROGRAMMING_REVIEW","Cette programmation utilise encore le parcours de déplacement historique.");
    }
    await tx.query("SET CONSTRAINTS planning_events_machine_no_overlap,planning_events_poste_no_overlap IMMEDIATE");
    const final=await readCentralSettings(tx);
    await tx.query("UPDATE public.planning_simulations SET status='APPLIED',applied_at=clock_timestamp(),applied_revision=$2 WHERE id=$1::uuid",[id,final.revision]);
    await auditApplication(tx,audit,id,result);
    return {id,revision:final.revision,result};
  });
}
