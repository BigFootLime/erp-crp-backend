import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { enqueueEntityChanged } from '../../../shared/realtime/realtime-outbox.service';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import type { AuditContext } from '../../production/repository/production.repository';
import { preparationAudit } from '../../production/repository/production-preparation.repository';
import { createRecursiveOrdresFabrication } from '../../production/domain/of-generation';
import { lockStockLaneTopology } from '../../stock/repository/stock-lane-routing.repository';
import { buildUrgencyRecoveries } from '../domain/delivery-urgency-request';
import type { DeliveryUrgencyBody } from '../validators/delivery-urgency.validators';
import { readDeliveryUrgencyPlan } from './delivery-urgency.repository';
import { acceptedUrgencyFee, type UrgencyOrderFee } from '../domain/urgency-order-fee';

type Db = Pick<PoolClient, 'query'>;
type RequestRow = {
  id: string; beneficiary_allocation_id: number; status: 'WAITING_PLANNER' | 'APPROVED' | 'WITHDRAWN' | 'CANCELLED';
  version: number; quantity: string; reason: string; created_at: string;
  cancelled_at: string | null; cancellation_reason: string | null;
  cancellation_retains_production: boolean | null;
  approved_id: string | null; withdrawn_id: string | null;
  urgency_fee: UrgencyOrderFee | null;
};
type RecoveryRow = {
  id: string; request_id: string; donor_allocation_id: number; recovery_of_id: number;
  quantity: string; protected_due_date: string; initial_ar_due_date: string;
  of_numero: string; of_status: string; commande_id: number; livraison_affaire_id: number;
  replenished_quantity: string; remaining_recovery_quantity: string;
};

export async function readUrgencyRequests(tx: Db, allocationId: number) {
  const requests = (await tx.query<RequestRow>(`SELECT id::text,beneficiary_allocation_id::int,status,version,
    quantity::text,reason,created_at::text,cancelled_at::text,cancellation_reason,cancellation_retains_production,approved_id::text,withdrawn_id::text,
    snapshot->'preview'->'urgency_fee' AS urgency_fee
    FROM public.delivery_urgency_requests WHERE beneficiary_allocation_id=$1 ORDER BY created_at DESC,id`, [allocationId])).rows;
  const recoveries = requests.length ? (await tx.query<RecoveryRow>(`SELECT recovery.id::text,recovery.request_id::text,
    recovery.donor_allocation_id::int,recovery.recovery_of_id::int,recovery.quantity::text,
    recovery.protected_due_date::text,recovery.initial_ar_due_date::text,
    producer.numero AS of_numero,producer.statut::text AS of_status,producer.commande_id::int,producer.affaire_id::int AS livraison_affaire_id,
    COALESCE(restored.quantity,0)::text AS replenished_quantity,
    GREATEST(0,recovery.quantity-COALESCE(restored.quantity,0))::text AS remaining_recovery_quantity
    FROM public.delivery_urgency_recoveries recovery JOIN public.ordres_fabrication producer ON producer.id=recovery.recovery_of_id
    LEFT JOIN LATERAL (SELECT sum(quantity) AS quantity FROM public.delivery_urgency_replenishments
      WHERE recovery_id=recovery.id) restored ON true
    WHERE recovery.request_id=ANY($1::uuid[]) ORDER BY recovery.donor_allocation_id,recovery.id`, [requests.map(r => r.id)])).rows : [];
  return requests.map(request => ({ ...request, can_withdraw: false as const,
    recoveries: recoveries.filter(recovery => recovery.request_id === request.id) }));
}

export async function repoListDeliveryUrgencyRequests(allocationId: number) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const requests = await readUrgencyRequests(tx, allocationId);
    await tx.query('COMMIT'); return requests;
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}

/** Only creates preparation evidence and draft OFs; donor stock stays reserved for its original affair. */
export async function repoCreateDeliveryUrgencyRequest(args: {
  allocationId: number; body: DeliveryUrgencyBody; idempotencyKey: string; audit: AuditContext;
}) {
  try { return await withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`delivery-urgency:${args.audit.user_id}:${args.idempotencyKey}`]);
    const requestHash = createHash('sha256').update(JSON.stringify({ allocation_id: args.allocationId, ...args.body })).digest('hex');
    const previous = (await tx.query<{ id: string; request_hash: string }>(`SELECT id::text,request_hash
      FROM public.delivery_urgency_requests WHERE created_by=$1 AND request_key=$2::uuid`, [args.audit.user_id, args.idempotencyKey])).rows[0];
    if (previous) {
      if (previous.request_hash !== requestHash)
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Cette clé correspond à une autre demande urgente.');
      return { request: (await readUrgencyRequests(tx, args.allocationId)).find(r => r.id === previous.id)!, replayed: true };
    }
    await lockStockLaneTopology(tx);
    const initial = await readDeliveryUrgencyPlan(tx, args.allocationId, args.body.quantity);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`delivery-urgency-client:${initial.context.client_id}`]);
    const pending = (await tx.query<{ id: string }>(`SELECT id::text FROM public.delivery_urgency_requests
      WHERE beneficiary_allocation_id=$1 AND status IN('WAITING_PLANNER','APPROVED')`, [args.allocationId])).rows[0];
    if (pending) throw new HttpError(409, 'URGENCY_ALREADY_PENDING', 'Une demande est déjà en attente pour cette affaire. Ouvrez son suivi.');
    if (initial.response.preview_hash !== args.body.preview_hash)
      throw new HttpError(409, 'URGENCY_PREVIEW_CHANGED', 'Les réservations ou les affaires ont changé. Actualisez la proposition.');
    const proposed = buildUrgencyRecoveries(initial.response);
    const sourceIds = proposed.flatMap(group => group.sources.map(s => s.reservation_id));
    const sources = initial.donors.filter(source => sourceIds.includes(source.reservation_id));
    const allocationIds = [args.allocationId, ...proposed.map(group => group.allocation_id)].sort((a,b) => a-b);
    // Match delivery locking order. NOWAIT avoids waiting behind a concurrent BL or quality transition.
    await tx.query('SELECT id FROM public.lots WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT', [sources.map(s => s.lot_id)]);
    await tx.query(`SELECT command.id FROM public.commande_client command JOIN public.commande_ligne_affaire_allocation allocation
      ON allocation.commande_id=command.id WHERE allocation.id=ANY($1::bigint[]) ORDER BY command.id FOR SHARE OF command NOWAIT`, [allocationIds]);
    await tx.query(`SELECT line.id FROM public.commande_ligne line JOIN public.commande_ligne_affaire_allocation allocation
      ON allocation.commande_ligne_id=line.id WHERE allocation.id=ANY($1::bigint[]) ORDER BY line.id FOR UPDATE OF line NOWAIT`, [allocationIds]);
    await tx.query('SELECT id FROM public.commande_ligne_affaire_allocation WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE NOWAIT', [allocationIds]);
    await tx.query('SELECT id FROM public.stock_reservations WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT', [sourceIds]);
    const current = await readDeliveryUrgencyPlan(tx, args.allocationId, args.body.quantity);
    if (current.response.preview_hash !== args.body.preview_hash)
      throw new HttpError(409, 'URGENCY_PREVIEW_CHANGED', 'Les réservations ou les affaires ont changé. Actualisez la proposition.');
    acceptedUrgencyFee(current.response.urgency_fee);
    const recoveries = buildUrgencyRecoveries(current.response), requestId = randomUUID();
    await tx.query(`INSERT INTO public.delivery_urgency_requests
      (id,beneficiary_allocation_id,quantity,reason,preview_hash,snapshot,request_key,request_hash,created_by)
      VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb,$7::uuid,$8,$9)`,
      [requestId,args.allocationId,current.response.requested_quantity,args.body.reason,args.body.preview_hash,
        JSON.stringify({ context: current.context, preview: current.response }),args.idempotencyKey,requestHash,args.audit.user_id]);
    for (const recovery of recoveries) {
      const source = current.donors.find(donor => donor.reservation_id === recovery.sources[0].reservation_id)!;
      // Replenish the donor's precise production definition, even when a compatible minor version is borrowed.
      const generated = await createRecursiveOrdresFabrication(tx, {
        source_type: 'MANUAL', commande_id: source.commande_id, commande_numero: source.commande_numero,
        commande_ligne_id: source.commande_ligne_id, livraison_affaire_id: source.livraison_affaire_id,
        client_id: source.client_id, root_article_id: source.article_id, root_piece_technique_id: source.piece_technique_id,
        root_pinned_version_id: source.technical_version_id, qty_to_produce: Number(recovery.quantity),
        user_id: args.audit.user_id, force_preparation: true,
      });
      const recoveryId = randomUUID();
      await tx.query(`INSERT INTO public.delivery_urgency_recoveries
        (id,request_id,donor_allocation_id,recovery_of_id,quantity,protected_due_date,initial_ar_due_date,donor_snapshot)
        VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::date,$7::date,$8::jsonb)`,
        [recoveryId,requestId,recovery.allocation_id,generated.root_of_id,recovery.quantity,recovery.due_date,source.initial_ar_due_date,
          JSON.stringify({ commande_id: source.commande_id, commande_ligne_id: source.commande_ligne_id,
            livraison_affaire_id: source.livraison_affaire_id, allocation_version: source.allocation_version,
            promise_version: source.promise_version, piece_technique_id: source.piece_technique_id,
            technical_version_id: source.technical_version_id, generated_of_ids: generated.ofs.map(of => of.id) })]);
      for (const proposedSource of recovery.sources) {
        const donor = current.donors.find(d => d.reservation_id === proposedSource.reservation_id)!;
        await tx.query(`INSERT INTO public.delivery_urgency_sources(recovery_id,donor_reservation_id,quantity,reservation_snapshot)
          VALUES($1::uuid,$2::uuid,$3,$4::jsonb)`, [recoveryId,donor.reservation_id,proposedSource.proposed_quantity,JSON.stringify(donor)]);
      }
      await preparationAudit(tx, args.audit, generated.root_of_id, 'production.of.urgency-recovery.prepare', {
        request_id: requestId, beneficiary_allocation_id: args.allocationId, donor_allocation_id: recovery.allocation_id,
        quantity: recovery.quantity, finish_before: recovery.due_date, initial_ar_due_date: source.initial_ar_due_date,
        withdrawal_authorized: false, reason: args.body.reason,
      });
    }
    await repoInsertAuditLog({ ...args.audit, tx, body: {
      event_type: 'ACTION', action: 'DELIVERY_URGENCY_REQUESTED', entity_type: 'affaire',
      entity_id: String(current.context.livraison_affaire_id), page_key: args.audit.page_key, path: args.audit.path,
      client_session_id: args.audit.client_session_id, details: { request_id: requestId, recoveries, can_withdraw: false },
    } });
    await enqueueEntityChanged(tx, { entityType: 'COMMANDE_CLIENT', entityId: String(current.context.commande_id),
      module: 'commandes-clients', action: 'updated', at: new Date().toISOString(),
      invalidateKeys: ['commandes:list',`commandes:detail:${current.context.commande_id}`,'livraisons:list','production:list'] },
      { deduplicationKey: `delivery-urgency-request:${requestId}` });
    return { request: (await readUrgencyRequests(tx, args.allocationId)).find(r => r.id === requestId)!, replayed: false };
  }); } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (['55P03','40P01','40001'].includes(code))
      throw new HttpError(409, 'URGENCY_BUSY', 'Une autre opération utilise ces affaires. Actualisez avant de préparer l’urgence.');
    throw error;
  }
}
