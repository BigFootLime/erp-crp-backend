import { describe, expect, it } from 'vitest';
import { consumeMaterialBar, proposeMaterialBarAllocation, reconcileMaterialBars, type MaterialBar, type MaterialBarHold } from './material-bars';

const bars = (...lengths: number[]): MaterialBar[] => lengths.map((lengthMm, index) => ({ id: `bar${index}`, batchId: 'batch', lengthMm, version: 1 }));
function inventory(physical: MaterialBar[], holds: MaterialBarHold[] = []) {
  const reservations = [...new Set(holds.map(h => h.reservationId))].map(id => ({ id, batchId: 'batch', remainingMm: holds.filter(h => h.reservationId === id).reduce((sum, h) => sum + h.remainingMm, 0) }));
  return reconcileMaterialBars({ bars: physical, holds, batches: [{ id: 'batch', physicalMm: physical.reduce((sum, b) => sum + b.lengthMm, 0), reservedMm: holds.reduce((sum, h) => sum + h.remainingMm, 0) }], reservations });
}
const plan = (physical: MaterialBar[], requiredBlanks: number, holds: MaterialBarHold[] = [], reservationIds: string[] = []) => proposeMaterialBarAllocation({ inventory: inventory(physical, holds), requiredBlanks, reservationIds, blankLengthMm: 110, kerfMm: .5 });

describe('physical bar coverage #1246', () => {
  it('does not join two ends of the same lot into a fictitious third blank', () => {
    const result = plan(bars(200, 200), 3);
    expect(result.missingBlanks).toBe(1);
    expect(result.allocations.map(a => a.quantityMm)).toEqual([110.5, 110.5]);
  });
  it('three 3m bars yield 81 whole blanks, not 81.44 or a fictitious single 9m bar', () => {
    const result = plan(bars(3000, 3000, 3000), 82);
    expect(result.missingBlanks).toBe(1);
    expect(result.allocations.map(a => a.quantityMm)).toEqual([2983.5, 2983.5, 2983.5]);
  });
  it('cannot cut a 3.5m blank from three separate 3m bars', () => {
    expect(proposeMaterialBarAllocation({ inventory: inventory(bars(3000, 3000, 3000)), reservationIds: [], requiredBlanks: 2, blankLengthMm: 3500, kerfMm: 0 }).missingBlanks).toBe(2);
  });
  it('tops up 11mm on the same held bar to reach 20 blanks', () => {
    const holds = [{ barId: 'bar0', reservationId: 'first', remainingMm: 2000 }, { barId: 'bar1', reservationId: 'second', remainingMm: 210 }];
    expect(plan(bars(2000, 1000), 20, holds, ['first', 'second'])).toEqual({ usableHeldBlanks: 19, missingBlanks: 0, allocations: [{ barId: 'bar1', batchId: 'batch', expectedVersion: 1, quantityMm: 11 }] });
  });
  it('combines accounting holds on one bar but never across physical bars', () => {
    const same = [{ barId: 'bar0', reservationId: 'a', remainingMm: 100 }, { barId: 'bar0', reservationId: 'b', remainingMm: 10.5 }];
    expect(plan(bars(110.5), 1, same, ['a', 'b'])).toMatchObject({ usableHeldBlanks: 1, allocations: [], missingBlanks: 0 });
    const split = [same[0], { ...same[1], barId: 'bar1' }];
    expect(plan(bars(100, 10.5), 1, split, ['a', 'b'])).toMatchObject({ usableHeldBlanks: 0, allocations: [], missingBlanks: 1 });
  });
  it('does not borrow the stock held by another OF', () => {
    const result = plan(bars(221), 2, [{ barId: 'bar0', reservationId: 'other', remainingMm: 110.5 }]);
    expect(result.allocations[0].quantityMm).toBe(110.5);
    expect(result.missingBlanks).toBe(1);
  });
  it('uses FIFO for untouched bars and does not allocate excess material', () => {
    expect(plan(bars(3000, 3000), 2).allocations).toEqual([{ barId: 'bar0', batchId: 'batch', expectedVersion: 1, quantityMm: 221 }]);
    expect(plan(bars(3000), 0).allocations).toEqual([]);
  });
  it('does not round a short bar up into a blank', () => {
    expect(plan(bars(110.499), 1).missingBlanks).toBe(1);
    expect(plan(bars(110.5), 1).missingBlanks).toBe(0);
  });
});

describe('geometry reconciliation #1246', () => {
  const base = () => ({ bars: bars(200), holds: [] as MaterialBarHold[], batches: [{ id: 'batch', physicalMm: 200, reservedMm: 0 }], reservations: [] as Array<{ id: string; batchId: string; remainingMm: number }> });
  it('rejects stock without confirmed bar lengths', () => { const input = base(); input.bars = []; expect(() => reconcileMaterialBars(input)).toThrow(/Confirmez les barres/); });
  it('rejects an external movement that invalidates geometry', () => { const input = base(); input.batches[0].physicalMm = 199; expect(() => reconcileMaterialBars(input)).toThrow(/Confirmez les barres/); });
  it('rejects canonical reservations absent from the bar allocation', () => { const input = base(); input.reservations.push({ id: 'hold', batchId: 'batch', remainingMm: 110 }); input.batches[0].reservedMm = 110; expect(() => reconcileMaterialBars(input)).toThrow(/Rapprochez les barres/); });
  it('rejects missing reservations from the canonical stock total', () => { const input = base(); input.batches[0].reservedMm = 110; expect(() => reconcileMaterialBars(input)).toThrow(/Rapprochez les réservations/); });
  it('rejects duplicate bars', () => { const input = base(); input.bars.push(input.bars[0]); expect(() => reconcileMaterialBars(input)).toThrow(/dupliquée/); });
  it('rejects duplicate hold pairs and allocations from another stock', () => {
    expect(() => inventory(bars(200), [{ barId: 'bar0', reservationId: 'a', remainingMm: 1 }, { barId: 'bar0', reservationId: 'a', remainingMm: 1 }])).toThrow(/affectation/);
    expect(() => inventory(bars(200), [{ barId: 'absent', reservationId: 'a', remainingMm: 1 }])).toThrow(/affectation/);
  });
  it.each([NaN, Infinity, -1, .0001, 1e9 + 1])('rejects invalid length %s', value => { expect(() => inventory(bars(value))).toThrow(); });
});

describe('physical debit #1246', () => {
  const input = () => ({ bar: bars(3000)[0], expectedVersion: 1, cutMm: 221, discardedMm: 0, close: false, acknowledgedLargeRemainder: false, heldByOtherNeedsMm: 0 });
  it('preserves the actual reusable end', () => { expect(consumeMaterialBar(input())).toEqual({ remainingMm: 2779, nextVersion: 2 }); });
  it('requires acknowledgement above 150mm but then permits closure', () => {
    const row = { ...input(), discardedMm: 2779, close: true };
    expect(() => consumeMaterialBar(row)).toThrow(/150 mm/);
    expect(consumeMaterialBar({ ...row, acknowledgedLargeRemainder: true }).remainingMm).toBe(0);
  });
  it('does not warn at exactly 150mm', () => { expect(consumeMaterialBar({ ...input(), cutMm: 2850, discardedMm: 150, close: true }).remainingMm).toBe(0); });
  it('rejects closure of only part of a bar', () => { expect(() => consumeMaterialBar({ ...input(), close: true })).toThrow(/toute la longueur/); });
  it('rejects consuming another OF reservation even with acknowledgement', () => { expect(() => consumeMaterialBar({ ...input(), discardedMm: 2779, close: true, acknowledgedLargeRemainder: true, heldByOtherNeedsMm: 100 })).toThrow(/autre besoin/); });
  it('rejects stale versions and quantities beyond the bar', () => {
    expect(() => consumeMaterialBar({ ...input(), expectedVersion: 2 })).toThrow(/a changé/);
    expect(() => consumeMaterialBar({ ...input(), cutMm: 3000.001 })).toThrow(/Vérifiez/);
  });
});
