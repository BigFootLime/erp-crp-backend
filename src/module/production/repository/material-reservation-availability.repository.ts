import type { DossierDb } from './of-dossier.repository';
import type { readMaterialTx } from './of-material.repository';
import { lotCompatibility, quantity } from '../domain/of-material';
import { readOperationalLotQualityEligibility } from '../../qualite/repository/quality-operational-gate.repository';

export type MaterialReservationAvailability = Map<string, { usable: number; reservations: Map<string, number>; blockers: string[] }>;

/** Same eligibility for the operation gate and the planning projection. A held
 * reservation is not automatically usable after a quarantine or definition change. */
export async function readMaterialReservationAvailabilityTx(tx: DossierDb, material: Awaited<ReturnType<typeof readMaterialTx>>) {
  const result: MaterialReservationAvailability = new Map();
  const quality = new Map<string, Awaited<ReturnType<typeof readOperationalLotQualityEligibility>>>();
  for (const need of material.needs) {
    const reservations = new Map<string, number>(), blockers: string[] = [];
    for (const reservation of need.reservations) {
      if (reservation.status !== 'ACTIVE' || !reservation.unexpired || Number(reservation.qty_reserved) <= Number(reservation.qty_consumed)) continue;
      const candidate = need.candidates.find(c => c.lot.id === reservation.lot_id && c.lot.batchId === reservation.stock_batch_id);
      if (!candidate) { blockers.push('Le lot réservé n’est plus physiquement disponible.'); continue; }
      const key = `${candidate.lot.id}:${need.unit}`;
      if (!quality.has(key)) quality.set(key, await readOperationalLotQualityEligibility({client: tx, lotId: candidate.lot.id, qty: 0, unit: need.unit, purpose: 'RESERVE'}));
      const incompatible = lotCompatibility(need, {...candidate.lot, qualityBlocks: quality.get(key)!.eligibility.blocks.map(b => b.message)});
      if (incompatible.length) blockers.push(...incompatible);
      else reservations.set(String(reservation.id), quantity(Math.max(0, Number(reservation.qty_reserved) - Number(reservation.qty_consumed))));
    }
    result.set(need.key, {usable: quantity([...reservations.values()].reduce((s, q) => s + q, 0)), reservations, blockers: [...new Set(blockers)]});
  }
  return result;
}
