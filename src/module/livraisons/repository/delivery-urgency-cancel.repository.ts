import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import { preparationAudit } from '../../production/repository/production-preparation.repository';
import type { AuditContext } from '../../production/repository/production.repository';
import type { DeliveryUrgencyCancelBody } from '../validators/delivery-urgency.validators';
import { readUrgencyRequests } from './delivery-urgency-request.repository';
import { readUrgencyCancellationTx } from './delivery-urgency-cancellation-preview.repository';
import { enqueueEntityChanged } from '../../../shared/realtime/realtime-outbox.service';

/** Retaining production is available only through the planner-authorized route.
 * Cancellation does not dissolve a group, undo supplier commitments or rewrite execution. */
export async function repoCancelDeliveryUrgencyRequest(args: {
  requestId: string; body: DeliveryUrgencyCancelBody; audit: AuditContext; retainProduction?: boolean;
}) {
  try { return await withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    // Read after the OF locks: a preparer may have committed while we waited.
    // Parent FK locks also prevent new children/operations appearing after review.
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
    const request = (await tx.query<{ beneficiary_allocation_id:number; status:string; version:number;
      cancelled_by:number|null; cancellation_reason:string|null; cancellation_retains_production:boolean|null }>(`SELECT beneficiary_allocation_id::int,status,version,cancelled_by,cancellation_reason,
      cancellation_retains_production
      FROM public.delivery_urgency_requests WHERE id=$1::uuid FOR UPDATE`,[args.requestId])).rows[0];
    if (!request) throw new HttpError(404,'URGENCY_REQUEST_NOT_FOUND','Demande urgente introuvable.');
    if (request.status==='CANCELLED' && request.version===args.body.expected_version+1 && request.cancelled_by===args.audit.user_id
      && request.cancellation_reason===args.body.reason && request.cancellation_retains_production===Boolean(args.retainProduction))
      return { request:(await readUrgencyRequests(tx,request.beneficiary_allocation_id)).find(r=>r.id===args.requestId)!,replayed:true };
    if (request.version!==args.body.expected_version || !['WAITING_PLANNER','APPROVED'].includes(request.status))
      throw new HttpError(409,'URGENCY_REQUEST_CHANGED','La demande a changé. Actualisez son suivi.');
    await tx.query(`SELECT of.id FROM public.ordres_fabrication of WHERE of.id IN
      (SELECT recovery_of_id FROM public.delivery_urgency_recoveries WHERE request_id=$1::uuid)
      OR of.root_of_id IN (SELECT recovery_of_id FROM public.delivery_urgency_recoveries WHERE request_id=$1::uuid)
      ORDER BY of.id FOR UPDATE`,[args.requestId]);
    const review=await readUrgencyCancellationTx(tx,args.requestId);
    const { tree, response }=review;
    if (!response.can_cancel) throw new HttpError(409,response.issues[0].code,response.issues[0].message);
    if ((args.retainProduction || args.body.preview_hash) && args.body.preview_hash!==response.preview_hash)
      throw new HttpError(409,'URGENCY_CANCELLATION_CHANGED','Les engagements ont changé. Actualisez le bilan d’annulation.');
    if (response.requires_planner && !args.retainProduction)
      throw new HttpError(409,'URGENCY_RECOVERY_ENGAGED','Le planificateur doit confirmer la conservation des engagements avant d’annuler.');
    const ids=tree.map(of=>of.id);
    if (!args.retainProduction) {
      await tx.query(`UPDATE public.of_component_requirements SET status='CANCELLED',updated_at=now()
      WHERE consuming_of_id=ANY($1::bigint[]) AND status<>'CANCELLED'`,[ids]);
      await tx.query(`UPDATE public.ordres_fabrication SET statut='ANNULE',updated_at=now(),updated_by=$2
      WHERE id=ANY($1::bigint[]) AND statut='BROUILLON'`,[ids,args.audit.user_id]);
    }
    await tx.query(`UPDATE public.delivery_urgency_requests SET status='CANCELLED',version=version+1,
      cancelled_by=$2,cancelled_at=now(),cancellation_reason=$3,cancellation_retains_production=$4,
      cancellation_evidence=$5::jsonb WHERE id=$1::uuid`,[args.requestId,args.audit.user_id,args.body.reason,
      Boolean(args.retainProduction),JSON.stringify({request:review.request,tree,preview_hash:response.preview_hash})]);
    for (const of of tree) await preparationAudit(tx,args.audit,of.id,'production.of.urgency-recovery.cancel',{
      request_id:args.requestId,reason:args.body.reason,donor_reservations_unchanged:true,
      production_retained:Boolean(args.retainProduction),finished_output_lane:args.retainProduction?'FREE':null,
    });
    await repoInsertAuditLog({...args.audit,tx,body:{event_type:'ACTION',action:'DELIVERY_URGENCY_CANCELLED',
      entity_type:'delivery_urgency_request',entity_id:args.requestId,page_key:args.audit.page_key,path:args.audit.path,
      client_session_id:args.audit.client_session_id,details:{reason:args.body.reason,cancelled_of_ids:args.retainProduction?[]:ids,
        retained_of_ids:args.retainProduction?ids:[],preview_hash:response.preview_hash,can_withdraw:false}}});
    await enqueueEntityChanged(tx,{entityType:'COMMANDE_CLIENT',entityId:String(review.request.commande_id),module:'commandes-clients',
      action:'updated',at:new Date().toISOString(),invalidateKeys:['livraisons:list','production:list','planning:list','stock:reservations']},
      {deduplicationKey:`delivery-urgency-cancel:${args.requestId}`});
    return { request:(await readUrgencyRequests(tx,request.beneficiary_allocation_id)).find(r=>r.id===args.requestId)!,replayed:false };
  }); } catch(error) {
    const code=error && typeof error==='object' && 'code' in error ? String(error.code) : '';
    if (['55P03','40P01','40001'].includes(code)) throw new HttpError(409,'URGENCY_CANCELLATION_BUSY',
      'Une autre opération a modifié la demande ou sa fabrication. Actualisez le bilan d’annulation.');
    throw error;
  }
}
