import { HttpError } from '../../../utils/httpError';
import type { MaterialBar, MaterialBarHold } from './material-bars';

export type BarOwnershipChange = {
  bar: MaterialBar;
  assignments: Array<{ reservationId: string; beforeMm: number; afterMm: number }>;
};
export type BarOwnershipProof = {
  barId: string;
  version: number;
  targetReservationId: string;
  targetMm: number;
  transfers: Array<{ reservationId: string; quantityMm: number }>;
};
export type BarRestorationGroup = {
  targetReservationId: string;
  sources: Array<{ reservationId: string; quantityMm: number }>;
};
const milli = (value: number) => Math.round(value * 1000);
function changed(): never {
  throw new HttpError(409, 'MATERIAL_BAR_TRANSFER_CHANGED',
    'Les affectations des barres ont changé. Actualisez le regroupement avant de transférer ou restituer sa matière.');
}

/** Only ownership changes. Each source keeps its original zeroed hold row. */
export function planBarOwnershipTransfer(input: {
  bars: MaterialBar[]; holds: MaterialBarHold[];
  sourceIds: string[]; targetReservationId: string;
}) {
  const sources = new Set(input.sourceIds);
  if (sources.size !== input.sourceIds.length || sources.has(input.targetReservationId)) changed();
  const changes: Array<BarOwnershipChange & { proof: Omit<BarOwnershipProof, 'version'> }> = [];
  for (const bar of input.bars) {
    const holds = input.holds.filter(h => h.barId === bar.id);
    const sourceHolds = holds.filter(h => sources.has(h.reservationId) && h.remainingMm > 0);
    const targetMm = holds.find(h => h.reservationId === input.targetReservationId)?.remainingMm ?? 0;
    if (!sourceHolds.length && !targetMm) continue;
    const afterMm = (milli(targetMm) + sourceHolds.reduce((sum, h) => sum + milli(h.remainingMm), 0)) / 1000;
    changes.push({ bar, assignments: [
      ...sourceHolds.map(h => ({ reservationId: h.reservationId, beforeMm: h.remainingMm, afterMm: 0 })),
      { reservationId: input.targetReservationId, beforeMm: targetMm, afterMm },
    ], proof: { barId: bar.id, targetReservationId: input.targetReservationId, targetMm: afterMm,
      transfers: sourceHolds.map(h => ({ reservationId: h.reservationId, quantityMm: h.remainingMm })) } });
  }
  if (input.sourceIds.some(id => !changes.some(c => c.proof.transfers.some(t => t.reservationId === id)))) changed();
  return changes;
}

/** Restore exact bar/source pairs, including later recovery additions. Versions
 * may advance for another OF: its unchanged physical holds are not overwritten. */
export function planBarOwnershipRestoration(input: {
  bars: MaterialBar[]; holds: MaterialBarHold[]; proofs: BarOwnershipProof[]; groups: BarRestorationGroup[];
}): BarOwnershipChange[] {
  const targets = new Set(input.groups.map(g => g.targetReservationId));
  const sources = input.groups.flatMap(g => g.sources);
  if (targets.size !== input.groups.length || new Set(sources.map(s => s.reservationId)).size !== sources.length
    || sources.some(s => targets.has(s.reservationId))) changed();
  const latest = new Map<string, BarOwnershipProof>();
  const transfers = new Map<string, { barId: string; reservationId: string; quantityMm: number }>();
  for (const proof of input.proofs) {
    const group = input.groups.find(g => g.targetReservationId === proof.targetReservationId);
    if (!group || !input.bars.some(b => b.id === proof.barId)) changed();
    const key = `${proof.barId}:${proof.targetReservationId}`;
    if (!latest.has(key) || latest.get(key)!.version < proof.version) latest.set(key, proof);
    for (const transfer of proof.transfers) {
      const sourceKey = `${proof.barId}:${transfer.reservationId}`;
      if (!group.sources.some(s => s.reservationId === transfer.reservationId) || transfers.has(sourceKey)) changed();
      transfers.set(sourceKey, { barId: proof.barId, ...transfer });
    }
  }
  for (const source of sources) {
    const total = [...transfers.values()].filter(t => t.reservationId === source.reservationId)
      .reduce((sum, t) => sum + milli(t.quantityMm), 0);
    if (total !== milli(source.quantityMm)) changed();
  }
  const owned = new Set([...targets, ...sources.map(s => s.reservationId)]);
  for (const hold of input.holds.filter(h => owned.has(h.reservationId) && h.remainingMm > 0)) {
    const proof = latest.get(`${hold.barId}:${hold.reservationId}`);
    if (!targets.has(hold.reservationId) || !proof || milli(proof.targetMm) !== milli(hold.remainingMm)) changed();
  }
  const changes: BarOwnershipChange[] = [];
  for (const bar of input.bars) {
    const targetProofs = [...latest.values()].filter(p => p.barId === bar.id);
    if (!targetProofs.length) continue;
    const assignments = targetProofs.map(proof => {
      const held = input.holds.find(h => h.barId === bar.id && h.reservationId === proof.targetReservationId)?.remainingMm ?? 0;
      if (milli(held) !== milli(proof.targetMm)) changed();
      return { reservationId: proof.targetReservationId, beforeMm: held, afterMm: 0 };
    });
    for (const transfer of transfers.values()) if (transfer.barId === bar.id)
      assignments.push({ reservationId: transfer.reservationId, beforeMm: 0, afterMm: transfer.quantityMm });
    // Surplus belongs to the producer and becomes free on dissolution.
    if (assignments.reduce((sum, a) => sum + milli(a.afterMm) - milli(a.beforeMm), 0) > 0) changed();
    changes.push({ bar, assignments });
  }
  if (input.groups.some(g => ![...latest.values()].some(p => p.targetReservationId === g.targetReservationId))) changed();
  return changes;
}
