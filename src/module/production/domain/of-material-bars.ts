import { proposeMaterialBarAllocation, type MaterialBar, type MaterialBarHold } from '../../stock/domain/material-bars';
import type { MaterialNeed } from './of-material';

/** Read-model geometry has already been reconciled against canonical stock.
 * Missing or stale inventories never stand for one continuous bar. */
export type MaterialBarCoverage = {
  status: 'CONFIRMED' | 'UNCONFIRMED' | 'REVIEW_REQUIRED';
  version: string;
  bars: MaterialBar[];
  holds: MaterialBarHold[];
  warning: string | null;
};
type BarNeed = Pick<MaterialNeed, 'reservations' | 'barInventories' | 'debitRule'>;
const milli = (value: number) => Math.round(value * 1000);

export function physicalMaterialReservationIds(need: BarNeed, batchId: string) {
  return (need.reservations ?? []).filter(r => r.stock_batch_id === batchId && r.status === 'ACTIVE' && r.unexpired)
    .map(r => r.id);
}

export function physicalMaterialHeldCapacity(need: BarNeed) {
  const rule = need.debitRule;
  if (!rule || rule.form !== 'BAR') return 0;
  const step = milli(rule.unitsPerBlank + rule.kerfPerBlank);
  if (!step) return 0;
  let capacity = 0;
  for (const [batchId, inventory] of Object.entries(need.barInventories ?? {})) {
    if (inventory.status !== 'CONFIRMED') continue;
    const owned = new Set(physicalMaterialReservationIds(need, batchId)), held = new Map<string, number>();
    for (const h of inventory.holds) if (owned.has(h.reservationId)) held.set(h.barId, (held.get(h.barId) ?? 0) + milli(h.remainingMm));
    for (const amount of held.values()) capacity += Math.floor(amount / step) * step;
  }
  return capacity / 1000;
}

/** The budget is the batch/location/quality limit, not a fictional bar length.
 * Previous need proposals reduce availableMmByBar without changing real stock. */
export function physicalMaterialSelection(need: BarNeed, batchId: string, maximumAdditionalMm: number,
  availableMmByBar?: ReadonlyMap<string, number>, maximumNewBlanks = 1e9) {
  const inventory = need.barInventories?.[batchId], rule = need.debitRule;
  if (!inventory || inventory.status !== 'CONFIRMED' || !rule || rule.form !== 'BAR')
    return { allocations: [], quantity: 0, coverage: 0 };
  const heldByBar = new Map<string, number>();
  for (const h of inventory.holds) heldByBar.set(h.barId, (heldByBar.get(h.barId) ?? 0) + milli(h.remainingMm));
  const own = new Set(physicalMaterialReservationIds(need, batchId));
  const held = new Map<string, number>(), step = milli(rule.unitsPerBlank + rule.kerfPerBlank);
  for (const h of inventory.holds) if (own.has(h.reservationId)) held.set(h.barId, (held.get(h.barId) ?? 0) + milli(h.remainingMm));
  const usableHeldBlanks = [...held.values()].reduce((sum, q) => sum + Math.floor(q / step), 0);
  const result = proposeMaterialBarAllocation({ inventory: { ...inventory, heldByBar },
    reservationIds: [...own], requiredBlanks: Math.min(1e9, usableHeldBlanks + maximumNewBlanks),
    blankLengthMm: rule.unitsPerBlank, kerfMm: rule.kerfPerBlank, maximumAdditionalMm, availableMmByBar });
  const coverage = result.allocations.reduce((sum, a) => sum +
    (Math.floor(((held.get(a.barId) ?? 0) + milli(a.quantityMm)) / step) - Math.floor((held.get(a.barId) ?? 0) / step)) * step, 0);
  return { allocations: result.allocations, quantity: result.allocations.reduce((sum, a) => sum + milli(a.quantityMm), 0) / 1000,
    coverage: coverage / 1000 };
}

export function physicalMaterialInventoryBlockers(need: BarNeed) {
  if (!need.barInventories || need.debitRule?.form !== 'BAR') return [];
  return [...new Set((need.reservations ?? []).filter(r => r.status === 'ACTIVE' && r.unexpired && r.qty_reserved > r.qty_consumed)
    .flatMap(r => {
      const inventory = r.stock_batch_id ? need.barInventories?.[r.stock_batch_id] : undefined;
      return inventory?.status === 'CONFIRMED' ? [] : [inventory?.warning ?? 'Confirmez les barres physiques de la matière réservée.'];
    }))];
}
