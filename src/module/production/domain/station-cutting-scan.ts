import { HttpError } from '../../../utils/httpError';
import type { MaterialBarCoverage } from './of-material-bars';

export type CuttingScanNeed = {
  operationId: string | null;
  reservations: ReadonlyArray<{ id: string; lot_id: string | null; stock_batch_id?: string | null;
    status: string; unexpired: boolean; qty_reserved: number; qty_consumed: number; lot_status?: string | null }>;
  candidates: ReadonlyArray<{ lot: { id: string; batchId: string; code: string } }>;
  barInventories?: Record<string, MaterialBarCoverage>;
};

type ScannedSource = { type: 'STOCK_LOT' | 'STOCK_MATERIAL_BAR'; id: string; code: string };
const unavailable = () => new HttpError(409, 'STATION_CUTTING_SOURCE_NOT_RESERVED',
  'Cette matière n’est pas réservée et utilisable pour cette découpe. Vérifiez la préparation de l’OF.');

/** Identify only the requested bar's holds; a lot scan never guesses a bar. */
export function cuttingScanSource(needs: readonly CuttingScanNeed[], operationId: string, entity: ScannedSource) {
  const scoped = needs.filter(need => need.operationId === operationId);
  const active = (reservation: CuttingScanNeed['reservations'][number]) => reservation.status === 'ACTIVE'
    && reservation.unexpired && reservation.qty_reserved > reservation.qty_consumed
    && (!reservation.lot_status || reservation.lot_status === 'LIBERE');
  if (entity.type === 'STOCK_LOT') {
    const reservations = scoped.flatMap(need => need.reservations).filter(reservation => active(reservation) && reservation.lot_id === entity.id);
    if (!reservations.length) throw unavailable();
    return { lotId: entity.id, lotCode: entity.code, reservationIds: [...new Set(reservations.map(reservation => reservation.id))],
      message: 'Lot identifié. Choisissez la barre puis confirmez les quantités.' };
  }
  for (const need of scoped) {
    for (const [batchId, inventory] of Object.entries(need.barInventories ?? {})) {
      const bar = inventory.bars.find(item => item.id === entity.id && item.lengthMm > 0);
      if (!bar || inventory.status !== 'CONFIRMED') continue;
      const reservations = need.reservations.filter(reservation => active(reservation) && reservation.stock_batch_id === batchId
        && inventory.holds.some(hold => hold.barId === bar.id && hold.reservationId === reservation.id && hold.remainingMm > 0));
      const lot = need.candidates.find(candidate => candidate.lot.batchId === batchId)?.lot;
      if (!reservations.length || !lot || reservations.some(reservation => reservation.lot_id !== lot.id)) continue;
      return { lotId: lot.id, lotCode: lot.code, barId: bar.id, barCode: bar.code ?? entity.code,
        reservationIds: [...new Set(reservations.map(reservation => reservation.id))], message: 'Barre identifiée et réservée pour cette découpe.' };
    }
  }
  throw unavailable();
}
