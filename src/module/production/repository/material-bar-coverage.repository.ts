import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { reconcileMaterialBars, type MaterialBar, type MaterialBarHold } from '../../stock/domain/material-bars';
import { coverageFingerprint } from '../domain/of-material';
import type { MaterialBarCoverage } from '../domain/of-material-bars';

/** Bulk read for an OF preview. A batch is a stock balance, never an implicit bar.
 * The caller supplies a consistent transaction or holds the stock lots for writes. */
export async function readMaterialBarCoverageTx(tx: Pick<PoolClient, 'query'>, batchIds: string[]): Promise<Record<string, MaterialBarCoverage>> {
  if (!batchIds.length) return {};
  const installed = (await tx.query<{ installed: boolean }>("SELECT to_regclass('public.stock_material_bar_inventories') IS NOT NULL AS installed")).rows[0]?.installed;
  if (!installed) return {};
  const batches = (await tx.query<{ id: string; unit: string; physicalMm: number; reservedMm: number;
    revision: number | null; recordedMovements: string | null; currentMovements: string }>(`SELECT b.id::text,lower(trim(a.unite)) AS unit,
      b.qty_total::float8 AS "physicalMm",b.qty_reserved::float8 AS "reservedMm",i.row_version AS revision,
      i.movement_count::text AS "recordedMovements",
      (SELECT count(*)::text FROM public.stock_movements m WHERE m.stock_batch_id=b.id AND m.status='POSTED') AS "currentMovements"
    FROM public.stock_batches b JOIN public.stock_levels s ON s.id=b.stock_level_id JOIN public.articles a ON a.id=s.article_id
    LEFT JOIN public.stock_material_bar_inventories i ON i.stock_batch_id=b.id WHERE b.id=ANY($1::uuid[]) ORDER BY b.id`, [batchIds])).rows;
  const bars = (await tx.query<MaterialBar>(`SELECT id::text,stock_batch_id::text AS "batchId",remaining_length_mm::float8 AS "lengthMm",row_version AS version
    FROM public.stock_material_bars WHERE stock_batch_id=ANY($1::uuid[]) AND retired_at IS NULL ORDER BY created_at,id`, [batchIds])).rows;
  const reservations = (await tx.query<{ id: string; batchId: string; remainingMm: number; version: number }>(`SELECT id::text,stock_batch_id::text AS "batchId",
      greatest(0,qty_reserved-qty_consumed)::float8 AS "remainingMm",row_version AS version
    FROM public.stock_reservations WHERE stock_batch_id=ANY($1::uuid[]) AND status='ACTIVE' AND qty_reserved>qty_consumed ORDER BY id`, [batchIds])).rows;
  const holds = (await tx.query<MaterialBarHold & { batchId: string }>(`SELECT h.bar_id::text AS "barId",h.reservation_id::text AS "reservationId",
      h.remaining_length_mm::float8 AS "remainingMm",b.stock_batch_id::text AS "batchId"
    FROM public.stock_material_bar_reservations h JOIN public.stock_material_bars b ON b.id=h.bar_id
    WHERE b.stock_batch_id=ANY($1::uuid[]) AND h.remaining_length_mm>0 ORDER BY h.bar_id,h.reservation_id`, [batchIds])).rows;
  const result: Record<string, MaterialBarCoverage> = {};
  for (const batch of batches) {
    const selectedBars = bars.filter(b => b.batchId === batch.id), selectedHolds = holds.filter(h => h.batchId === batch.id);
    const selectedReservations = reservations.filter(r => r.batchId === batch.id);
    let status: MaterialBarCoverage['status'] = batch.revision === null ? 'UNCONFIRMED' : 'CONFIRMED';
    let warning: string | null = status === 'UNCONFIRMED' ? 'Confirmez les barres physiques de ce lot.' : null;
    if (batch.unit !== 'mm') { status = 'REVIEW_REQUIRED'; warning = 'La règle de débit des barres doit utiliser les millimètres.'; }
    if (status === 'CONFIRMED') {
      try {
        if (batch.recordedMovements !== batch.currentMovements)
          throw new HttpError(409, 'MATERIAL_BAR_INVENTORY_CHANGED', 'Un mouvement impose de vérifier les barres restantes.');
        reconcileMaterialBars({ bars: selectedBars, holds: selectedHolds, reservations: selectedReservations, batches: [batch] });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        status = 'REVIEW_REQUIRED'; warning = error.message;
      }
    }
    result[batch.id] = { status, warning, bars: selectedBars, holds: selectedHolds,
      version: coverageFingerprint({ batch, bars: selectedBars, holds: selectedHolds, reservations: selectedReservations }) };
  }
  return result;
}
