import { createHash, randomUUID } from 'node:crypto';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { enqueueEntityChanged } from '../../../shared/realtime/realtime-outbox.service';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import { assertOperationalLotQualityEligibility } from '../../qualite/repository/quality-operational-gate.repository';
import { lockStockLaneTopology } from '../../stock/repository/stock-lane-routing.repository';
import { preparationAudit } from '../../production/repository/production-preparation.repository';
import type { AuditContext } from '../../production/repository/production.repository';
import type { DeliveryUrgencyRestitutionBody } from '../validators/delivery-urgency.validators';
import { readUrgencyCancellationTx } from './delivery-urgency-cancellation-preview.repository';
import { readUrgencyRequests } from './delivery-urgency-request.repository';
import { refreshUrgencyDonorCoverageTx } from './urgency-withdrawal-stock.repository';
import { restoreUrgencyStockTx } from './urgency-restitution-stock.repository';

/** Planner-authorized restitution. No production or finance commitment is erased. */
export async function repoRestoreDeliveryUrgency(args: {
  requestId: string; body: DeliveryUrgencyRestitutionBody; idempotencyKey: string; audit: AuditContext;
}) {
  try { return await withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`urgency-restitution:${args.audit.user_id}:${args.idempotencyKey}`]);
    const hash = createHash('sha256').update(JSON.stringify([args.requestId,args.body])).digest('hex');
    const previous = (await tx.query<{ request_hash: string; response: unknown; beneficiary_allocation_id: number }>(`SELECT restitution.request_hash,
      restitution.response,request.beneficiary_allocation_id::int FROM public.delivery_urgency_restitutions restitution
      JOIN public.delivery_urgency_requests request ON request.id=restitution.request_id
      WHERE restitution.created_by=$1 AND restitution.request_key=$2::uuid`, [args.audit.user_id,args.idempotencyKey])).rows[0];
    if (previous) {
      if (previous.request_hash !== hash) throw new HttpError(409,'IDEMPOTENCY_CONFLICT','Cette clé correspond à une autre restitution.');
      return { request: (await readUrgencyRequests(tx,previous.beneficiary_allocation_id)).find(row=>row.id===args.requestId)!,
        restitution: previous.response, replayed: true };
    }
    const request = (await tx.query<{ beneficiary_allocation_id: number; status: string; version: number; withdrawn_id: string }>(`SELECT
      beneficiary_allocation_id::int,status,version,withdrawn_id::text FROM public.delivery_urgency_requests WHERE id=$1::uuid FOR UPDATE NOWAIT`, [args.requestId])).rows[0];
    if (!request) throw new HttpError(404,'URGENCY_REQUEST_NOT_FOUND','Demande urgente introuvable.');
    if (request.status !== 'WITHDRAWN' || request.version !== args.body.expected_version)
      throw new HttpError(409,'URGENCY_REQUEST_CHANGED','La demande a changé. Actualisez le retour.');
    // Receipts use this same recovery lock before recording a replacement.
    await tx.query('SELECT id FROM public.delivery_urgency_recoveries WHERE request_id=$1::uuid ORDER BY id FOR UPDATE NOWAIT', [args.requestId]);
    await lockStockLaneTopology(tx);
    const initial = await readUrgencyCancellationTx(tx,args.requestId);
    const assertCurrent = (review: typeof initial) => {
      if (review.response.preview_hash !== args.body.preview_hash || review.response.request_version !== args.body.expected_version)
        throw new HttpError(409,'URGENCY_RETURN_CHANGED','Le stock, la récupération ou le forfait a changé. Actualisez le retour.');
      if (!review.restitution || !review.response.can_cancel || !review.restitution.response.can_restore)
        throw new HttpError(409,'URGENCY_RETURN_NOT_READY','Corrigez les points signalés avant de restituer.', { issues:review.response.issues });
    };
    assertCurrent(initial);
    const evidence = initial.restitution!.evidence;
    await tx.query('SELECT id FROM public.delivery_urgency_order_charges WHERE id=$1::uuid FOR UPDATE NOWAIT', [evidence.fee!.id]);
    const lots = new Map(evidence.reservations.map(row=>[row.lot_id,row]));
    for (const [id,row] of [...lots].sort(([a],[b])=>a.localeCompare(b))) {
      if (row.source_scope === 'NEW') await assertOperationalLotQualityEligibility({ client:tx,lotId:id,qty:0,unit:row.unit,purpose:'RESERVE' });
      else await tx.query('SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE NOWAIT',[id]);
    }
    const allocationIds = [...new Set([request.beneficiary_allocation_id,...evidence.recoveries.map(row=>row.donor_allocation_id)])].sort((a,b)=>a-b);
    await tx.query(`SELECT allocation.id FROM public.commande_ligne_affaire_allocation allocation
      JOIN public.commande_client command ON command.id=allocation.commande_id
      JOIN public.affaire affair ON affair.id=allocation.livraison_affaire_id
      JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id
      JOIN public.articles article ON article.id=line.article_id WHERE allocation.id=ANY($1::bigint[])
      ORDER BY allocation.id FOR SHARE OF command,affair,article NOWAIT`,[allocationIds]);
    await tx.query(`SELECT id FROM public.commande_ligne WHERE id IN
      (SELECT commande_ligne_id FROM public.commande_ligne_affaire_allocation WHERE id=ANY($1::bigint[])) ORDER BY id FOR UPDATE NOWAIT`,[allocationIds]);
    await tx.query(`SELECT id FROM public.commande_ligne_affaire_allocation WHERE commande_ligne_id IN
      (SELECT commande_ligne_id FROM public.commande_ligne_affaire_allocation WHERE id=ANY($1::bigint[])) ORDER BY id FOR UPDATE NOWAIT`,[allocationIds]);
    await tx.query('SELECT id FROM public.stock_levels WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',[evidence.reservations.map(row=>row.stock_level_id)]);
    await tx.query('SELECT id FROM public.stock_batches WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',[evidence.reservations.map(row=>row.stock_batch_id)]);
    await tx.query('SELECT id FROM public.stock_reservations WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',[evidence.reservations.map(row=>row.id)]);
    const checked = await readUrgencyCancellationTx(tx,args.requestId); assertCurrent(checked);
    const review = checked.restitution!, restorationId = randomUUID();
    const response = { id:restorationId,request_id:args.requestId,status:'CANCELLED' as const,quantity:review.response.quantity,
      donor_quantity:review.response.donor_quantity,free_quantity:review.response.free_quantity,fee_decision:'KEEP' as const,charge_id:review.evidence.fee!.id };
    await tx.query(`INSERT INTO public.delivery_urgency_restitutions
      (id,request_id,withdrawal_id,request_version,charge_id,fee_decision,reason,evidence,response,preview_hash,request_key,request_hash,created_by)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8::jsonb,$9::jsonb,$10,$11::uuid,$12,$13)`,
    [restorationId,args.requestId,request.withdrawn_id,args.body.expected_version,review.evidence.fee!.id,args.body.fee_decision,args.body.reason,
      JSON.stringify(review.evidence),JSON.stringify(response),args.body.preview_hash,args.idempotencyKey,hash,args.audit.user_id]);
    await restoreUrgencyStockTx(tx,{ restorationId,review,audit:args.audit });
    await refreshUrgencyDonorCoverageTx(tx,allocationIds);
    await tx.query(`UPDATE public.delivery_urgency_requests SET status='CANCELLED',version=version+1,restitution_id=$2::uuid,
      cancelled_by=$3,cancelled_at=now(),cancellation_reason=$4,cancellation_retains_production=true,cancellation_evidence=$5::jsonb
      WHERE id=$1::uuid`,[args.requestId,restorationId,args.audit.user_id,args.body.reason,
      JSON.stringify({request:checked.request,tree:checked.tree,restitution_id:restorationId,preview_hash:args.body.preview_hash,fee_decision:'KEEP'})]);
    for (const row of checked.tree) await preparationAudit(tx,args.audit,row.id,'production.of.urgency-recovery.restituted',response);
    await repoInsertAuditLog({...args.audit,tx,body:{event_type:'ACTION',action:'DELIVERY_URGENCY_RESTITUTED',entity_type:'delivery_urgency_request',
      entity_id:args.requestId,page_key:args.audit.page_key,path:args.audit.path,client_session_id:args.audit.client_session_id,
      details:{...response,reason:args.body.reason,production_retained:true}}});
    for (const id of new Set([Number(review.evidence.request.commande_id),...review.evidence.recoveries.map(row=>row.commande_id)]))
      await enqueueEntityChanged(tx,{entityType:'COMMANDE_CLIENT',entityId:String(id),module:'commandes-clients',action:'updated',at:new Date().toISOString(),
        invalidateKeys:['livraisons:list','stock:reservations','production:list','planning:list',`commandes:detail:${id}`]},
        {deduplicationKey:`urgency-restitution:${restorationId}:${id}`});
    return {request:(await readUrgencyRequests(tx,request.beneficiary_allocation_id)).find(row=>row.id===args.requestId)!,restitution:response,replayed:false};
  }); } catch (error) {
    const code=error && typeof error==='object' && 'code' in error ? String(error.code) : '';
    if (['55P03','40P01','40001'].includes(code)) throw new HttpError(409,'URGENCY_RETURN_BUSY','Une autre opération utilise ce stock ou cette affaire. Actualisez le retour.');
    throw error;
  }
}
