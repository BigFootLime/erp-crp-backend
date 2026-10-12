import { createHash, randomUUID } from 'node:crypto';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { enqueueEntityChanged } from '../../../shared/realtime/realtime-outbox.service';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import { assertOperationalLotQualityEligibility } from '../../qualite/repository/quality-operational-gate.repository';
import { lockStockLaneTopology } from '../../stock/repository/stock-lane-routing.repository';
import type { AuditContext } from '../../production/repository/production.repository';
import { preparationAudit } from '../../production/repository/production-preparation.repository';
import { readUrgencyWithdrawalTx } from './delivery-urgency-withdrawal-preview.repository';
import { recordDeliveryUrgencyFeeTx } from './delivery-urgency-fee.repository';
import { refreshUrgencyDonorCoverageTx, transferUrgencyReservationTx, type UrgencyStockTransfer } from './urgency-withdrawal-stock.repository';
/** Reassign existing physical stock only after a current, feasible planner approval. */
export async function repoWithdrawDeliveryUrgency(args: {
    requestId: string;
    expectedVersion: number;
    previewHash: string;
    idempotencyKey: string;
    audit: AuditContext;
}) {
    try {
        return await withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
            await tx.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
            await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`urgency-withdrawal:${args.audit.user_id}:${args.idempotencyKey}`]);
            const requestHash = createHash('sha256').update(JSON.stringify([args.requestId, args.expectedVersion, args.previewHash])).digest('hex');
            const previous = (await tx.query<{
                request_hash: string;
                response: unknown;
            }>(`SELECT request_hash,response
        FROM public.delivery_urgency_withdrawals WHERE created_by=$1 AND request_key=$2::uuid`, [args.audit.user_id, args.idempotencyKey])).rows[0];
            if (previous) {
                if (previous.request_hash !== requestHash)
                    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Cette clé correspond à un autre prélèvement.');
                return { withdrawal: previous.response, replayed: true };
            }
            await tx.query('SELECT id FROM public.delivery_urgency_requests WHERE id=$1::uuid FOR UPDATE NOWAIT', [args.requestId]);
            await lockStockLaneTopology(tx);
            const initial = await readUrgencyWithdrawalTx(tx, args.requestId);
            const assertCurrent = (control: typeof initial) => {
                if (control.response.request_version !== args.expectedVersion || control.response.preview_hash !== args.previewHash)
                    throw new HttpError(409, 'URGENCY_WITHDRAWAL_CHANGED', 'Le stock, l’affaire ou le planning a changé. Actualisez le contrôle.');
                if (!control.response.can_withdraw || !control.approval)
                    throw new HttpError(409, 'URGENCY_WITHDRAWAL_NOT_READY', 'Le prélèvement n’est pas autorisé. Corrigez les points signalés.', { issues: control.response.issues });
            };
            assertCurrent(initial);
            const { current } = initial;
            const donors = current.sources.map(source => {
                const donor = current.donorPlan.donors.find(item => item.reservation_id === source.donor_reservation_id);
                if (!donor)
                    throw new HttpError(409, 'URGENCY_DONOR_CHANGED', 'Une réservation donneuse n’est plus disponible.');
                return donor;
            });
            // Same locking order as delivery reservation/receipt writers: quality, orders, then stock.
            const byLot = new Map(donors.map(donor => [donor.lot_id, donor]));
            for (const [lotId, donor] of [...byLot].sort(([a], [b]) => a.localeCompare(b))) {
                if (donor.source_scope === 'NEW')
                    await assertOperationalLotQualityEligibility({
                        client: tx, lotId, qty: 0, unit: current.donorPlan.context.unit, purpose: 'RESERVE',
                    });
                else
                    await tx.query('SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE NOWAIT', [lotId]);
            }
            const allocationIds = [...new Set([current.request.beneficiary_allocation_id, ...donors.map(d => d.allocation_id)])].sort((a, b) => a - b);
            const lineIds = [...new Set([current.donorPlan.context.commande_ligne_id, ...donors.map(d => d.commande_ligne_id)])].sort((a, b) => a - b);
            await tx.query(`SELECT allocation.id FROM public.commande_ligne_affaire_allocation allocation
        JOIN public.commande_client command ON command.id=allocation.commande_id
        JOIN public.affaire affair ON affair.id=allocation.livraison_affaire_id
        JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id
        JOIN public.articles article ON article.id=line.article_id
        JOIN public.piece_technique_versions technical ON technical.id=line.piece_technique_version_id
        JOIN public.pieces_techniques piece ON piece.id=technical.piece_technique_id
        WHERE allocation.id=ANY($1::bigint[]) ORDER BY allocation.id
        FOR SHARE OF command,affair,article,technical,piece NOWAIT`, [allocationIds]);
            await tx.query('SELECT id FROM public.commande_ligne WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE NOWAIT', [lineIds]);
            await tx.query('SELECT id FROM public.commande_ligne_affaire_allocation WHERE commande_ligne_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE NOWAIT', [lineIds]);
            await tx.query('SELECT id FROM public.stock_levels WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT', [donors.map(d => d.stock_level_id)]);
            await tx.query('SELECT id FROM public.stock_batches WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT', [donors.map(d => d.stock_batch_id)]);
            await tx.query('SELECT id FROM public.stock_reservations WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT', [donors.map(d => d.reservation_id)]);
            await tx.query(`SELECT location.id FROM public.locations location
        JOIN public.warehouses warehouse ON warehouse.id=location.warehouse_id
        JOIN public.emplacements emplacement ON emplacement.location_id=location.id
        JOIN public.magasins magasin ON magasin.id=emplacement.magasin_id
        WHERE location.id=ANY($1::uuid[]) ORDER BY location.id
        FOR SHARE OF location,warehouse,emplacement,magasin NOWAIT`, [donors.map(d => d.location_id)]);
            const checked = await readUrgencyWithdrawalTx(tx, args.requestId);
            assertCurrent(checked);
            const transfers: UrgencyStockTransfer[] = [];
            for (const source of checked.current.sources) {
                const donor = checked.current.donorPlan.donors.find(d => d.reservation_id === source.donor_reservation_id)!;
                transfers.push(await transferUrgencyReservationTx(tx, {
                    sourceId: source.id, source: donor, quantity: source.quantity, requestId: args.requestId,
                    actor: args.audit.user_id, beneficiary: checked.current.donorPlan.context,
                }));
            }
            await refreshUrgencyDonorCoverageTx(tx, checked.current.recoveries.map(r => r.donor_allocation_id));
            const withdrawalId = randomUUID();
            const charge = await recordDeliveryUrgencyFeeTx(tx, { requestId: args.requestId, withdrawalId, actor: args.audit.user_id });
            const response = { id: withdrawalId, request_id: args.requestId, approval_id: checked.approval!.id,
                urgency_charge: charge,
                status: 'WITHDRAWN' as const, request_version: args.expectedVersion + 1, quantity: checked.current.request.quantity,
                beneficiary_allocation_id: checked.current.request.beneficiary_allocation_id,
                transfers: transfers.map(({ reservation_evidence: _evidence, ...transfer }) => transfer),
                recovery_of_ids: checked.current.recoveries.map(recovery => recovery.recovery_of_id),
            };
            await tx.query(`INSERT INTO public.delivery_urgency_withdrawals
        (id,request_id,approval_id,request_version,quantity,preview_hash,evidence,response,request_key,request_hash,created_by)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8::jsonb,$9::uuid,$10,$11)`, [withdrawalId, args.requestId, checked.approval!.id, args.expectedVersion, checked.current.request.quantity, args.previewHash,
                JSON.stringify({ control: checked.response, planning_basis: checked.current.basis }), JSON.stringify(response),
                args.idempotencyKey, requestHash, args.audit.user_id]);
            for (const transfer of transfers)
                await tx.query(`INSERT INTO public.delivery_urgency_transfers
        (withdrawal_id,source_id,donor_reservation_id,beneficiary_reservation_id,quantity,reservation_evidence)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb)`, [withdrawalId, transfer.source_id, transfer.donor_reservation_id, transfer.beneficiary_reservation_id, transfer.quantity, JSON.stringify(transfer.reservation_evidence)]);
            const updated = await tx.query(`UPDATE public.delivery_urgency_requests SET status='WITHDRAWN',withdrawn_id=$2::uuid,version=version+1
        WHERE id=$1::uuid AND version=$3 AND status='APPROVED' RETURNING id`, [args.requestId, withdrawalId, args.expectedVersion]);
            if (updated.rowCount !== 1)
                throw new HttpError(409, 'URGENCY_WITHDRAWAL_CHANGED', 'La demande a changé. Actualisez le contrôle.');
            for (const recovery of checked.current.recoveries)
                await preparationAudit(tx, args.audit, recovery.recovery_of_id, 'production.of.urgency-recovery.withdraw', { request_id: args.requestId, withdrawal_id: withdrawalId,
                    donor_allocation_id: recovery.donor_allocation_id, quantity: recovery.quantity, finish_before: recovery.protected_due_date });
            await repoInsertAuditLog({ ...args.audit, tx, body: { event_type: 'ACTION', action: 'DELIVERY_URGENCY_WITHDRAWN',
                    entity_type: 'delivery_urgency_request', entity_id: args.requestId, page_key: args.audit.page_key, path: args.audit.path,
                    client_session_id: args.audit.client_session_id, details: response } });
            const commands = [...new Set([checked.current.donorPlan.context.commande_id, ...donors.map(d => d.commande_id)])];
            for (const id of commands)
                await enqueueEntityChanged(tx, { entityType: 'COMMANDE_CLIENT', entityId: String(id),
                    module: 'commandes-clients', action: 'updated', at: new Date().toISOString(),
                    invalidateKeys: ['commandes:list', `commandes:detail:${id}`, 'livraisons:list', 'stock:reservations', 'production:list', 'planning:list'] }, { deduplicationKey: `delivery-urgency-withdrawal:${withdrawalId}:${id}` });
            return { withdrawal: response, replayed: false };
        });
    }
    catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (['55P03', '40P01', '40001'].includes(code))
            throw new HttpError(409, 'URGENCY_BUSY', 'Une autre opération utilise ces affaires ou ce stock. Actualisez avant de prélever.');
        throw error;
    }
}
