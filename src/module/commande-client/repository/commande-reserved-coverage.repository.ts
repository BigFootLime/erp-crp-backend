import type { PoolClient } from 'pg';

type OrderLine = { commande_ligne_id: number; article_id: string | null; qty_ordered: number | string };
type Reservation = {
  commande_ligne_id: number; article_id: string; quantity: number; stock_scope: string;
  stock_level_id: string; physical_reserved: number; usable_physical: number; lot_released: boolean;
  stock_batch_id: string | null; batch_reserved: number | null; batch_usable: number | null;
};
export type OwnedStockCoverage = { old_qty: number; new_qty: number };

/** Already reserved units belong to this line, not to the free-stock pool. */
export async function readFullyReservedCommandeCoverage(
  tx: Pick<PoolClient, 'query'>, commandeId: number, lines: readonly OrderLine[],
): Promise<Map<number, OwnedStockCoverage> | null> {
  if (!lines.length) return null;
  const result = await tx.query<Reservation>(
    `SELECT reservation.commande_ligne_id::int AS commande_ligne_id,
            reservation.article_id::text AS article_id, reservation.qty_reserved::float8 AS quantity,
            CASE WHEN lot.origin_stock_scope = 'OLD' THEN 'OLD'
                 ELSE COALESCE(reservation.source_scope, lot.source_scope, lot.stock_scope, 'NEW') END AS stock_scope,
            level.id::text AS stock_level_id, level.qty_reserved::float8 AS physical_reserved,
            (level.qty_total - COALESCE(level.qty_depreciated,0))::float8 AS usable_physical,
            reservation.stock_batch_id::text AS stock_batch_id,
            batch.qty_reserved::float8 AS batch_reserved,
            (batch.qty_total - batch.qty_depreciated)::float8 AS batch_usable,
            COALESCE(lot.lot_status,'LIBERE') = 'LIBERE' AS lot_released
       FROM public.stock_reservations reservation
       JOIN public.commande_ligne line ON line.id = reservation.commande_ligne_id AND line.commande_id = $1
       JOIN public.stock_levels level ON level.id = reservation.stock_level_id
         AND level.article_id = reservation.article_id AND level.location_id = reservation.location_id
         AND level.managed_in_stock = true
       LEFT JOIN public.stock_batches batch ON batch.id = reservation.stock_batch_id
         AND batch.stock_level_id = level.id AND batch.lot_id IS NOT DISTINCT FROM reservation.lot_id
       JOIN public.lots lot ON lot.id = reservation.lot_id
      WHERE reservation.source_type = 'COMMANDE_LIGNE'
        AND reservation.source_id = reservation.commande_ligne_id::text AND reservation.status = 'ACTIVE'
      ORDER BY reservation.commande_ligne_id, reservation.id`,
    [commandeId],
  );
  if (!result.rows.length) return null;
  const expected = new Map(lines.map(line => [line.commande_ligne_id, line]));
  const coverage = new Map<number, OwnedStockCoverage>();
  const byLevel = new Map<string, number>();
  const byBatch = new Map<string, number>();
  for (const row of result.rows) {
    const line = expected.get(row.commande_ligne_id), quantity = Number(row.quantity);
    if (!line || row.article_id !== line.article_id || !Number.isFinite(quantity) || quantity <= 0
      || !row.lot_released || !['OLD', 'NEW'].includes(row.stock_scope)) return null;
    const levelQuantity = (byLevel.get(row.stock_level_id) ?? 0) + quantity;
    if (![row.physical_reserved, row.usable_physical].every(value => Number.isFinite(Number(value)))
      || levelQuantity > Number(row.physical_reserved) + 1e-9
      || Number(row.physical_reserved) > Number(row.usable_physical) + 1e-9) return null;
    byLevel.set(row.stock_level_id, levelQuantity);
    if (row.stock_batch_id) {
      const batchQuantity = (byBatch.get(row.stock_batch_id) ?? 0) + quantity;
      if (row.batch_reserved === null || row.batch_usable === null
        || ![row.batch_reserved, row.batch_usable].every(value => Number.isFinite(Number(value)))
        || batchQuantity > Number(row.batch_reserved) + 1e-9
        || Number(row.batch_reserved) > Number(row.batch_usable) + 1e-9) return null;
      byBatch.set(row.stock_batch_id, batchQuantity);
    }
    const lineCoverage = coverage.get(row.commande_ligne_id) ?? { old_qty: 0, new_qty: 0 };
    if (row.stock_scope === 'OLD') lineCoverage.old_qty += quantity;
    else lineCoverage.new_qty += quantity;
    coverage.set(row.commande_ligne_id, lineCoverage);
  }
  if (lines.some(line => {
    const covered = coverage.get(line.commande_ligne_id);
    const requested = Number(line.qty_ordered);
    return !covered || !Number.isFinite(requested) || requested <= 0
      || Math.abs(covered.old_qty + covered.new_qty - requested) > 1e-9;
  })) return null;
  return coverage;
}
