import type { PoolClient } from 'pg';
import type { AuditContext } from './production.repository';
import { HttpError } from '../../../utils/httpError';
import { quantity } from '../domain/of-material';
import { assertStockConsumptionAllowed, lockStockStates, stockTargetKey } from '../../stock/repository/stock.repository';
type HoldRow = {
    id: string;
    article_id: string;
    location_id: string;
    lot_id: string;
    stock_batch_id: string;
    stock_level_id: string;
    qty_reserved: number;
    qty_consumed: number;
    qty_prepared: number;
    of_id: number;
    source_type: string;
    source_id: string;
    material_need_id: string;
    status: string;
    unexpired: boolean;
};
const HOLD_SELECT = `SELECT r.id::text,r.article_id::text,r.location_id::text,r.lot_id::text,r.stock_batch_id::text,
  s.id::text AS stock_level_id,r.qty_reserved::float8,r.qty_consumed::float8,r.qty_prepared::float8,
  r.of_id::bigint::int,r.source_type,r.source_id,r.material_need_id::text,r.status,(r.expires_at IS NULL OR r.expires_at>now()) AS unexpired
  FROM public.stock_reservations r JOIN public.stock_levels s ON s.article_id=r.article_id AND s.location_id=r.location_id`;
const physicalKey = (r: HoldRow) => `${r.article_id}:${r.location_id}:${r.lot_id}`;
function unchangedHold(r: HoldRow) {
    return r.source_type === 'OF' && r.source_id === String(r.of_id) && r.status === 'ACTIVE' && r.unexpired && Number(r.qty_consumed) === 0 && Number(r.qty_prepared) === 0
        && Boolean(r.lot_id && r.stock_batch_id) && Number(r.qty_reserved) > 0;
}
function changed(): never {
    throw new HttpError(409, 'CONSOLIDATION_MATERIAL_CHANGED', 'Les réservations matière ont changé. Rechargez le regroupement.');
}
/** Source holds are replaced atomically, without changing their physical stock
 * counters. Surplus was reserved separately through the canonical stock API. */
export async function aggregateConsolidationHoldsTx(tx: PoolClient, input: {
    consolidationId: string;
    producerId: number;
    needId: string;
    articleId: string;
    sources: Array<{
        ofId: number;
        needId: string;
        reservations: string[];
    }>;
    surplusReservationIds: string[];
}, audit: AuditContext) {
    const sourceMap = new Map(input.sources.flatMap(s => s.reservations.map(id => [id, s] as const)));
    const sourceIds = [...sourceMap.keys()];
    if (sourceIds.length !== input.sources.reduce((n, s) => n + s.reservations.length, 0))
        changed();
    const sourceRows = (await tx.query<HoldRow>(`${HOLD_SELECT} WHERE r.id=ANY($1::uuid[]) ORDER BY r.id FOR UPDATE OF r`, [sourceIds])).rows;
    const extraRows = (await tx.query<HoldRow>(`${HOLD_SELECT} WHERE r.id=ANY($1::uuid[]) ORDER BY r.id FOR UPDATE OF r`, [input.surplusReservationIds])).rows;
    if (sourceRows.length !== sourceIds.length || extraRows.length !== input.surplusReservationIds.length)
        changed();
    for (const r of sourceRows) {
        const source = sourceMap.get(r.id)!;
        if (!unchangedHold(r) || r.of_id !== source.ofId || r.material_need_id !== source.needId || r.article_id !== input.articleId)
            changed();
    }
    for (const r of extraRows)
        if (!unchangedHold(r) || r.of_id !== input.producerId || r.material_need_id !== input.needId || r.article_id !== input.articleId)
            changed();
    await lockStockStates(tx, [...sourceRows, ...extraRows].map(r => ({ stock_level_id: r.stock_level_id, stock_batch_id: r.stock_batch_id })));
    const groups = new Map<string, {
        sources: HoldRow[];
        extra: HoldRow | null;
    }>();
    for (const r of sourceRows) {
        const key = physicalKey(r);
        const group = groups.get(key) ?? { sources: [], extra: null };
        group.sources.push(r);
        groups.set(key, group);
    }
    for (const r of extraRows) {
        const key = physicalKey(r);
        const group = groups.get(key) ?? { sources: [], extra: null };
        if (group.extra)
            changed();
        group.extra = r;
        groups.set(key, group);
    }
    for (const group of groups.values()) {
        const first = group.sources[0] ?? group.extra!;
        if (group.sources.some(r => r.stock_batch_id !== first.stock_batch_id) || (group.extra && group.extra.stock_batch_id !== first.stock_batch_id))
            changed();
        const transferred = quantity(group.sources.reduce((n, r) => n + Number(r.qty_reserved), 0));
        const surplus = quantity(Number(group.extra?.qty_reserved ?? 0));
        let producerReservationId = group.extra?.id;
        if (producerReservationId) {
            await tx.query(`UPDATE public.stock_reservations SET qty_reserved=qty_reserved+$2,updated_at=now(),updated_by=$3,
        correlation_id=$4::uuid WHERE id=$1::uuid`, [producerReservationId, transferred, audit.user_id, input.consolidationId]);
        }
        else {
            producerReservationId = (await tx.query<{
                id: string;
            }>(`INSERT INTO public.stock_reservations
        (article_id,location_id,lot_id,stock_batch_id,qty_reserved,source_type,source_id,of_id,material_need_id,status,
         reason,correlation_id,created_by,updated_by)
        SELECT article_id,location_id,lot_id,stock_batch_id,$2,'OF',$3::bigint::text,$3::bigint,$4::uuid,'ACTIVE',
          'Matière transférée au regroupement',$5::uuid,$6,$6 FROM public.stock_reservations WHERE id=$1::uuid RETURNING id::text`, [first.id, transferred, input.producerId, input.needId, input.consolidationId, audit.user_id])).rows[0]?.id;
            if (!producerReservationId)
                changed();
        }
        // The aggregate cannot extend a source hold's expiry.
        const allIds = [...group.sources.map(r => r.id), ...(group.extra ? [group.extra.id] : [])];
        await tx.query(`UPDATE public.stock_reservations SET expires_at=(SELECT min(expires_at) FROM public.stock_reservations
      WHERE id=ANY($2::uuid[])) WHERE id=$1::uuid`, [producerReservationId, allIds]);
        await tx.query(`INSERT INTO public.production_consolidation_material_holds
      (consolidation_id,producer_reservation_id,producer_need_id,transferred_qty,surplus_qty) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5)`, [input.consolidationId, producerReservationId, input.needId, transferred, surplus]);
        for (const source of group.sources) {
            const original = sourceMap.get(source.id)!;
            await tx.query(`INSERT INTO public.production_consolidation_material_transfers
        (consolidation_id,reservation_id,source_of_id,source_need_id,producer_need_id,producer_reservation_id,source_reserved_qty)
        VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7)`, [input.consolidationId, source.id, original.ofId, original.needId, input.needId, producerReservationId, source.qty_reserved]);
        }
        // Only the ownership changes. The new hold already represents these exact
        // commitments, so decrementing counters here would make stock falsely free.
        await tx.query(`UPDATE public.stock_reservations SET status='RELEASED',released_at=now(),released_by=$2,
      reason='Réservation transférée au regroupement',correlation_id=$3::uuid,updated_at=now(),updated_by=$2
      WHERE id=ANY($1::uuid[])`, [group.sources.map(r => r.id), audit.user_id, input.consolidationId]);
    }
}
/** New ledgers contain every producer hold, including surplus-only lots.
 * Source reservation IDs and quantities remain intact for exact restitution. */
export async function restoreConsolidationHoldsTx(tx: PoolClient, consolidationId: string, producerId: number, audit: AuditContext) {
    const holds = (await tx.query<{
        producer_reservation_id: string;
        producer_need_id: string;
        transferred_qty: string;
        surplus_qty: string;
    }>(`SELECT producer_reservation_id::text,producer_need_id::text,transferred_qty::text,surplus_qty::text
      FROM public.production_consolidation_material_holds WHERE consolidation_id=$1::uuid ORDER BY producer_reservation_id`, [consolidationId])).rows;
    if (!holds.length)
        return; // Legacy transfers are restored by their existing path.
    const sourceTransfers = (await tx.query<{
        reservation_id: string;
        producer_reservation_id: string;
        source_reserved_qty: string;
        source_of_id: number;
        source_need_id: string;
    }>(`SELECT reservation_id::text,producer_reservation_id::text,source_reserved_qty::text,source_of_id::bigint::int,source_need_id::text
      FROM public.production_consolidation_material_transfers WHERE consolidation_id=$1::uuid AND producer_reservation_id IS NOT NULL`, [consolidationId])).rows;
    const ids = [...holds.map(h => h.producer_reservation_id), ...sourceTransfers.map(t => t.reservation_id)];
    // Preserve lot -> stock -> reservation lock order, also used by quality gates.
    await tx.query(`SELECT l.id FROM public.lots l WHERE l.id IN(SELECT lot_id FROM public.stock_reservations WHERE id=ANY($1::uuid[])) ORDER BY l.id FOR UPDATE`, [ids]);
    const unlocked = (await tx.query<HoldRow>(`${HOLD_SELECT} WHERE r.id=ANY($1::uuid[])`, [ids])).rows;
    const states = await lockStockStates(tx, unlocked.flatMap(r => [
        { stock_level_id: r.stock_level_id, stock_batch_id: r.stock_batch_id },
        { stock_level_id: r.stock_level_id, stock_batch_id: null },
    ]));
    const rows = (await tx.query<HoldRow>(`${HOLD_SELECT} WHERE r.id=ANY($1::uuid[]) ORDER BY r.id FOR UPDATE OF r`, [ids])).rows;
    const byId = new Map(rows.map(r => [r.id, r]));
    if (rows.length !== ids.length)
        changed();
    const surplusByLevel = new Map<string, number>();
    const surplusByBatch = new Map<string, {
        levelId: string;
        qty: number;
    }>();
    const totalByLevel = new Map<string, number>();
    const totalByBatch = new Map<string, {
        levelId: string;
        qty: number;
    }>();
    for (const hold of holds) {
        const r = byId.get(hold.producer_reservation_id)!;
        const originalTransfers = sourceTransfers.filter(t => t.producer_reservation_id === r.id);
        if (!unchangedHold(r) || r.of_id !== producerId || r.material_need_id !== hold.producer_need_id
            || quantity(Number(r.qty_reserved)) !== quantity(Number(hold.transferred_qty) + Number(hold.surplus_qty))
            || quantity(originalTransfers.reduce((n, t) => n + Number(t.source_reserved_qty), 0)) !== quantity(Number(hold.transferred_qty)))
            changed();
        for (const original of originalTransfers) {
            const source = byId.get(original.reservation_id)!;
            if (source.source_type !== 'OF' || source.source_id !== String(original.source_of_id)
                || source.status !== 'RELEASED' || source.of_id !== original.source_of_id || source.material_need_id !== original.source_need_id
                || !source.unexpired || Number(source.qty_consumed) !== 0 || Number(source.qty_prepared) !== 0
                || quantity(Number(source.qty_reserved)) !== quantity(Number(original.source_reserved_qty))
                || physicalKey(source) !== physicalKey(r) || source.stock_batch_id !== r.stock_batch_id)
                changed();
        }
        const surplus = Number(hold.surplus_qty);
        surplusByLevel.set(r.stock_level_id, quantity((surplusByLevel.get(r.stock_level_id) ?? 0) + surplus));
        const batch = surplusByBatch.get(r.stock_batch_id) ?? { levelId: r.stock_level_id, qty: 0 };
        batch.qty = quantity(batch.qty + surplus);
        surplusByBatch.set(r.stock_batch_id, batch);
        totalByLevel.set(r.stock_level_id, quantity((totalByLevel.get(r.stock_level_id) ?? 0) + Number(r.qty_reserved)));
        const total = totalByBatch.get(r.stock_batch_id) ?? { levelId: r.stock_level_id, qty: 0 };
        total.qty = quantity(total.qty + Number(r.qty_reserved));
        totalByBatch.set(r.stock_batch_id, total);
    }
    for (const [batchId, delta] of totalByBatch) {
        const state = states.get(stockTargetKey({ stock_level_id: delta.levelId, stock_batch_id: batchId }));
        if (!state)
            changed();
        if (delta.qty > 0)
            assertStockConsumptionAllowed(state, { movement_type: 'UNRESERVE', qty: delta.qty });
    }
    for (const [levelId, qty] of totalByLevel) {
        const state = states.get(stockTargetKey({ stock_level_id: levelId, stock_batch_id: null }));
        if (!state)
            changed();
        if (qty > 0)
            assertStockConsumptionAllowed(state, { movement_type: 'UNRESERVE', qty });
    }
    for (const [levelId, qty] of surplusByLevel)
        if (qty > 0)
            await tx.query(`UPDATE public.stock_levels
    SET qty_reserved=qty_reserved-$2,updated_at=now(),updated_by=$3 WHERE id=$1::uuid`, [levelId, qty, audit.user_id]);
    for (const [batchId, delta] of surplusByBatch)
        if (delta.qty > 0)
            await tx.query(`UPDATE public.stock_batches
    SET qty_reserved=qty_reserved-$2 WHERE id=$1::uuid`, [batchId, delta.qty]);
    await tx.query(`UPDATE public.stock_reservations SET status='RELEASED',released_at=now(),released_by=$2,
    reason='Dissolution du regroupement',correlation_id=$3::uuid,updated_at=now(),updated_by=$2 WHERE id=ANY($1::uuid[])`, [holds.map(h => h.producer_reservation_id), audit.user_id, consolidationId]);
    await tx.query(`UPDATE public.stock_reservations SET status='ACTIVE',released_at=NULL,released_by=NULL,
    reason='Réservation source restituée après dissolution',correlation_id=$3::uuid,updated_at=now(),updated_by=$2 WHERE id=ANY($1::uuid[])`, [sourceTransfers.map(t => t.reservation_id), audit.user_id, consolidationId]);
}
