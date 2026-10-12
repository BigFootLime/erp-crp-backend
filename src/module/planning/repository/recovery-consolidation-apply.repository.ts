import {createHash,randomUUID} from 'node:crypto';
import pool from '../../../config/database';
import {HttpError} from '../../../utils/httpError';
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {enqueueEntityChanged} from '../../../shared/realtime/realtime-outbox.service';
import {repoInsertAuditLog} from '../../audit-logs/repository/audit-logs.repository';
import {readRecoveryConsolidationContextTx} from './recovery-consolidation-context.repository';
import {readRecoveryConsolidationControlTx} from './recovery-consolidation-preview.repository';
import {applyRecoveryCommitmentsTx} from './recovery-consolidation-commitments.repository';
import {appendRecoveryConsolidationHoldsTx} from '../../production/repository/recovery-consolidation-holds.repository';
import {readOfComponentCoverageTx} from '../../production/repository/of-component-coverage.repository';
import {validateRecoveryProducerDossierTx} from '../../production/repository/recovery-consolidation-dossier.repository';
import {preparationAudit} from '../../production/repository/production-preparation.repository';
import type {AuditContext} from '../../production/repository/production.repository';
import type {RecoveryConsolidationApplyInput} from '../validators/recovery-consolidation.validators';

export async function applyRecoveryGrouping(recoveryId:string,consolidationId:string,input:RecoveryConsolidationApplyInput,audit:AuditContext) {
  try {return await withRealtimeOutboxTransaction(await pool.connect(),async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    const settings=(await tx.query<{revision:string;activation:string}>(`SELECT revision::text,activation
      FROM public.planning_central_settings WHERE singleton FOR UPDATE`)).rows[0];
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`recovery-grouping:${audit.user_id}:${input.idempotency_key}`]);
    const requestHash=createHash('sha256').update(JSON.stringify([recoveryId,consolidationId,input])).digest('hex');
    const previous=(await tx.query<{request_hash:string;response:unknown}>(`SELECT request_hash,response FROM public.production_recovery_consolidation_additions
      WHERE created_by=$1 AND request_key=$2::uuid`,[audit.user_id,input.idempotency_key])).rows[0];
    if(previous) {
      if(previous.request_hash!==requestHash)throw new HttpError(409,'IDEMPOTENCY_CONFLICT','Cette clé correspond à un autre ajout.');
      return {addition:previous.response,replayed:true};
    }
    if(!settings||!['COMMIT','EXECUTE','LEARN'].includes(settings.activation))
      throw new HttpError(409,'PLANNING_NOT_COMMITTABLE','Activez la validation du planning avant cet ajout.');
    const now=new Date().toISOString(),reference=Date.parse(input.planning_reference_at);
    if(!Number.isFinite(reference)||reference<Date.parse(now)||reference>Date.parse(now)+121000)
      throw new HttpError(409,'RECOVERY_PROPOSAL_EXPIRED','Actualisez la proposition avant de confirmer les créneaux.');
    const initial=await readRecoveryConsolidationContextTx(tx,recoveryId,consolidationId);
    const ofIds=[initial.producer.id,initial.recovery.id].sort((a,b)=>a-b);
    await tx.query('SELECT id FROM public.ordres_fabrication WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE',[ofIds]);
    await tx.query('SELECT id FROM public.delivery_urgency_requests WHERE id=$1::uuid FOR UPDATE',[initial.context.request_id]);
    await tx.query('SELECT id FROM public.production_consolidations WHERE id=$1::uuid FOR UPDATE',[consolidationId]);
    await tx.query(`SELECT id FROM public.of_component_requirements WHERE consuming_of_id=ANY($1::bigint[]) AND status<>'CANCELLED' ORDER BY id FOR UPDATE`,[ofIds]);
    const control=await readRecoveryConsolidationControlTx(tx,recoveryId,consolidationId,now,input.planning_reference_at);
    const {response:preview,context,material,snapshot}=control;
    if(preview.request_version!==input.expected_request_version||preview.preview_hash!==input.preview_hash
      ||preview.proposal_hash!==input.proposal_hash||preview.planning_revision!==settings.revision)
      throw new HttpError(409,'RECOVERY_GROUPING_CHANGED','Le stock, le dossier ou le planning a changé. Actualisez le contrôle.');
    if(!preview.feasible||!preview.proposed_finish||!preview.finish_before)
      throw new HttpError(409,'RECOVERY_GROUPING_NOT_READY','Corrigez les points signalés avant cet ajout.',{issues:preview.issues});
    const additionId=randomUUID(),allocationId=randomUUID(),validationId=randomUUID();
    const selected=snapshot.tasks.filter(t=>t.ofId===context.producer.id&&t.source==='OPERATION');
    const operations=selected.map(task=>{
      const change=preview.changes.find(c=>c.taskId===task.id),interval=change?.after??task.committed;
      if(!task.operationId||!interval)throw new HttpError(409,'RECOVERY_OPERATION_UNPLANNED','Une opération ne dispose pas de créneau engagé.');
      return {operation_id:task.operationId,start:interval.start,end:interval.end,resource_id:(change?.resourceIds??task.resourceIds)[0]};
    });
    const response={id:additionId,recovery_id:recoveryId,request_id:context.context.request_id,consolidation_id:consolidationId,
      producer_of_id:context.producer.id,recovery_of_id:context.recovery.id,quantity:preview.proposed_quantity,
      added_quantity:preview.additional_quantity,planned_finish:preview.proposed_finish,
      base_planning_revision:settings.revision,can_withdraw:false,requires_urgency_approval:context.context.request_status!=='WITHDRAWN'};
    // This immutable decision permits only this exact quantity increase in the
    // current transaction. Deferred guards require every remaining write below.
    await tx.query(`INSERT INTO public.production_recovery_consolidation_additions
      (id,recovery_id,consolidation_id,producer_of_id,recovery_of_id,previous_quantity,additional_quantity,new_quantity,
       allocation_id,dossier_validation_id,finish_before,proposed_finish,technical_hash,request_key,request_hash,preview_hash,
       base_planning_revision,evidence,response,created_by)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::uuid,$10::uuid,$11,$12,$13,$14::uuid,$15,$16,$17::bigint,$18::jsonb,$19::jsonb,$20)`,
    [additionId,recoveryId,consolidationId,context.producer.id,context.recovery.id,preview.previous_quantity,preview.additional_quantity,preview.proposed_quantity,
      allocationId,validationId,preview.finish_before,preview.proposed_finish,context.producer.technicalHash,input.idempotency_key,requestHash,input.preview_hash,
      settings.revision,JSON.stringify({operations,preview,source:context.recovery,donor:context.context.donor_snapshot}),JSON.stringify(response),audit.user_id]);
    const transfers=await appendRecoveryConsolidationHoldsTx(tx,{consolidationId,recoveryId,producerId:context.producer.id,
      recoveryOfId:context.recovery.id,materialVersion:material.version},audit);
    // The material helper also locks physical holds used for assembly; recheck
    // the component quality and quantity versions before transferring ownership.
    for(const previousCoverage of control.components) {
      const current=await readOfComponentCoverageTx(tx,previousCoverage.ofId,previousCoverage.assembly);
      if(!current.ready||current.version!==previousCoverage.version)
        throw new HttpError(409,'RECOVERY_COMPONENTS_CHANGED','Les sous-pièces ont changé. Actualisez la proposition.');
    }
    await tx.query(`INSERT INTO public.production_consolidation_component_transfers(consolidation_id,requirement_id,source_of_id)
      SELECT $1::uuid,id,consuming_of_id FROM public.of_component_requirements WHERE consuming_of_id=$2 AND status<>'CANCELLED'`,[consolidationId,context.recovery.id]);
    await tx.query(`UPDATE public.of_component_requirements SET consuming_of_id=$1,updated_at=now()
      WHERE consuming_of_id=$2 AND status<>'CANCELLED'`,[context.producer.id,context.recovery.id]);
    await tx.query(`UPDATE public.stock_reservations SET of_id=$1,updated_at=now(),updated_by=$3 WHERE of_id=$2
      AND of_component_requirement_id IN(SELECT requirement_id FROM public.production_consolidation_component_transfers WHERE consolidation_id=$4::uuid)
      AND status='ACTIVE'`,[context.producer.id,context.recovery.id,audit.user_id,consolidationId]);
    await tx.query(`INSERT INTO public.production_consolidation_allocations(id,consolidation_id,source_of_id,quantity,due_date,source_updated_at)
      VALUES($1::uuid,$2::uuid,$3,$4,($5::timestamptz AT TIME ZONE 'Europe/Paris')::date,$6::timestamptz)`,
    [allocationId,consolidationId,context.recovery.id,preview.additional_quantity,preview.finish_before,context.recovery.updated_at]);
    await tx.query(`UPDATE public.ordres_fabrication SET quantite_lancee=$2,updated_at=clock_timestamp(),updated_by=$3 WHERE id=$1`,
      [context.producer.id,preview.proposed_quantity,audit.user_id]);
    await applyRecoveryCommitmentsTx(tx,context.producer.id,snapshot,preview.changes,audit);
    await validateRecoveryProducerDossierTx(tx,context.producer.id,additionId,validationId,audit);
    for(const ofId of ofIds)await preparationAudit(tx,audit,ofId,'production.consolidation.recovery-addition',{
      ...response,material_transfers:transfers,dossier_validation_id:validationId,operations});
    await repoInsertAuditLog({...audit,tx,body:{event_type:'ACTION',action:'RECOVERY_CONSOLIDATION_ADDED',entity_type:'production_consolidation',
      entity_id:consolidationId,page_key:audit.page_key,path:audit.path,client_session_id:audit.client_session_id,details:response}});
    await enqueueEntityChanged(tx,{entityType:'COMMANDE_CLIENT',entityId:String(context.recovery.commande_id),module:'commandes-clients',
      action:'updated',at:new Date().toISOString(),invalidateKeys:['production:list','planning:list','livraisons:list']},
    {deduplicationKey:`recovery-consolidation:${additionId}`});
    // Force deferred business constraints before returning a successful result.
    await tx.query('SET CONSTRAINTS recovery_consolidation_addition_complete,recovery_material_extension_allocation IMMEDIATE');
    return {addition:response,replayed:false};
  });}catch(error) {
    const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
    if(['55P03','40P01','40001','23P01','23505'].includes(code))
      throw new HttpError(409,'RECOVERY_GROUPING_BUSY','Le planning ou les réservations ont changé pendant l’ajout. Actualisez le contrôle.');
    throw error;
  }
}
