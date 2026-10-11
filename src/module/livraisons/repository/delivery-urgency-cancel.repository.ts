import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import { preparationAudit } from '../../production/repository/production-preparation.repository';
import type { AuditContext } from '../../production/repository/production.repository';
import type { DeliveryUrgencyCancelBody } from '../validators/delivery-urgency.validators';
import { readUrgencyRequests } from './delivery-urgency-request.repository';

/** Cancel only untouched draft trees. An engaged recovery needs an explicit planning reconciliation. */
export async function repoCancelDeliveryUrgencyRequest(args: {
  requestId: string; body: DeliveryUrgencyCancelBody; audit: AuditContext;
}) {
  return withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
    const request = (await tx.query<{ beneficiary_allocation_id:number; status:string; version:number;
      cancelled_by:number|null; cancellation_reason:string|null }>(`SELECT beneficiary_allocation_id::int,status,version,cancelled_by,cancellation_reason
      FROM public.delivery_urgency_requests WHERE id=$1::uuid FOR UPDATE`,[args.requestId])).rows[0];
    if (!request) throw new HttpError(404,'URGENCY_REQUEST_NOT_FOUND','Demande urgente introuvable.');
    if (request.status==='CANCELLED' && request.version===args.body.expected_version+1 && request.cancelled_by===args.audit.user_id
      && request.cancellation_reason===args.body.reason)
      return { request:(await readUrgencyRequests(tx,request.beneficiary_allocation_id)).find(r=>r.id===args.requestId)!,replayed:true };
    if (request.version!==args.body.expected_version || request.status!=='WAITING_PLANNER')
      throw new HttpError(409,'URGENCY_REQUEST_CHANGED','La demande a changé. Actualisez son suivi.');
    const roots=(await tx.query<{recovery_of_id:number}>(`SELECT recovery_of_id::int FROM public.delivery_urgency_recoveries
      WHERE request_id=$1::uuid ORDER BY recovery_of_id`,[args.requestId])).rows.map(r=>r.recovery_of_id);
    const tree=(await tx.query<{id:number;statut:string;technical_snapshot_sha256:string|null}>(`SELECT id::int,statut::text,technical_snapshot_sha256
      FROM public.ordres_fabrication WHERE id=ANY($1::bigint[]) OR root_of_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,[roots])).rows;
    if (!roots.length || roots.some(id=>!tree.some(of=>of.id===id)))
      throw new HttpError(409,'URGENCY_RECOVERY_MISSING','Un OF de récupération manque. Faites vérifier le dossier.');
    if (tree.some(of=>!['BROUILLON','ANNULE'].includes(of.statut) || of.technical_snapshot_sha256))
      throw new HttpError(409,'URGENCY_RECOVERY_ENGAGED','Une récupération est déjà préparée ou planifiée. Le planificateur doit revoir ses engagements.');
    const ids=tree.map(of=>of.id);
    const used=(await tx.query(`SELECT 1 WHERE
      EXISTS(SELECT 1 FROM public.of_operations WHERE of_id=ANY($1::bigint[]))
      OR EXISTS(SELECT 1 FROM public.of_material_needs WHERE of_id=ANY($1::bigint[]))
      OR EXISTS(SELECT 1 FROM public.stock_reservations WHERE status IN('ACTIVE','CONSUMED')
        AND (of_id=ANY($1::bigint[]) OR of_component_requirement_id IN
          (SELECT id FROM public.of_component_requirements WHERE consuming_of_id=ANY($1::bigint[]))))
      OR EXISTS(SELECT 1 FROM public.of_component_requirements WHERE component_of_id=ANY($1::bigint[])
        AND NOT(consuming_of_id=ANY($1::bigint[])) AND status<>'CANCELLED')`,[ids])).rows.length>0;
    if (used) throw new HttpError(409,'URGENCY_RECOVERY_ENGAGED','Une récupération a des opérations ou des approvisionnements. Le planificateur doit les réconcilier avant annulation.');
    await tx.query(`UPDATE public.of_component_requirements SET status='CANCELLED',updated_at=now()
      WHERE consuming_of_id=ANY($1::bigint[]) AND status<>'CANCELLED'`,[ids]);
    await tx.query(`UPDATE public.ordres_fabrication SET statut='ANNULE',updated_at=now(),updated_by=$2
      WHERE id=ANY($1::bigint[]) AND statut='BROUILLON'`,[ids,args.audit.user_id]);
    await tx.query(`UPDATE public.delivery_urgency_requests SET status='CANCELLED',version=version+1,
      cancelled_by=$2,cancelled_at=now(),cancellation_reason=$3 WHERE id=$1::uuid`,[args.requestId,args.audit.user_id,args.body.reason]);
    for (const of of tree.filter(of=>of.statut==='BROUILLON')) await preparationAudit(tx,args.audit,of.id,'production.of.urgency-recovery.cancel',{
      request_id:args.requestId,reason:args.body.reason,donor_reservations_unchanged:true,
    });
    await repoInsertAuditLog({...args.audit,tx,body:{event_type:'ACTION',action:'DELIVERY_URGENCY_CANCELLED',
      entity_type:'delivery_urgency_request',entity_id:args.requestId,page_key:args.audit.page_key,path:args.audit.path,
      client_session_id:args.audit.client_session_id,details:{reason:args.body.reason,cancelled_of_ids:ids,can_withdraw:false}}});
    return { request:(await readUrgencyRequests(tx,request.beneficiary_allocation_id)).find(r=>r.id===args.requestId)!,replayed:false };
  });
}
