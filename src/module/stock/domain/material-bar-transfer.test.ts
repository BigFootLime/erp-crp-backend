import { describe, expect, it } from 'vitest';
import { planBarOwnershipTransfer, planBarOwnershipRestoration, type BarOwnershipProof } from './material-bar-transfer';
const bars = [{ id: 'a', batchId: 'batch', lengthMm: 1000, version: 1 }, { id: 'b', batchId: 'batch', lengthMm: 500, version: 1 }];
const held = (barId: string, reservationId: string, remainingMm: number) => ({ barId, reservationId, remainingMm });
const holds = [held('a', 'r1', 221), held('a', 'r2', 110.5), held('b', 'r2', 110.5), held('b', 'producer', 110.5), held('a', 'other', 100)];
const transfer = () => planBarOwnershipTransfer({ bars, holds, sourceIds: ['r1', 'r2'], targetReservationId: 'producer' });
const groups = [{ targetReservationId: 'producer', sources: [{ reservationId: 'r1', quantityMm: 221 }, { reservationId: 'r2', quantityMm: 221 }] }];
const proofs = (): BarOwnershipProof[] => transfer().map(c => ({ ...c.proof, version: 2 }));
const current = () => ({ bars: bars.map(b => ({ ...b, version: 2 })), holds: [held('a', 'producer', 331.5), held('b', 'producer', 221), held('a', 'other', 100)], groups, proofs: proofs() });

describe('regrouped bar ownership', () => {
  it('combines source holds on their original bars and preserves surplus and other OFs', () => {
    const changes = transfer();
    expect(changes.map(c => c.proof.targetMm)).toEqual([331.5, 221]);
    expect(changes.flatMap(c => c.assignments).some(a => a.reservationId === 'other')).toBe(false);
    expect(changes.map(c => c.bar.lengthMm)).toEqual([1000, 500]);
  });
  it('restores the exact bar/source pairs and releases only surplus', () => {
    const changes = planBarOwnershipRestoration(current());
    expect(changes.map(c => c.assignments)).toEqual([
      [{ reservationId: 'producer', beforeMm: 331.5, afterMm: 0 }, { reservationId: 'r1', beforeMm: 0, afterMm: 221 }, { reservationId: 'r2', beforeMm: 0, afterMm: 110.5 }],
      [{ reservationId: 'producer', beforeMm: 221, afterMm: 0 }, { reservationId: 'r2', beforeMm: 0, afterMm: 110.5 }],
    ]);
  });
  it('includes a later recovery hold in the latest target snapshot', () => {
    const input = current();
    input.holds[0].remainingMm += 110.5;
    input.proofs.push({ barId: 'a', version: 3, targetReservationId: 'producer', targetMm: 442,
      transfers: [{ reservationId: 'recovery', quantityMm: 110.5 }] });
    input.groups = [{ ...groups[0], sources: [...groups[0].sources, { reservationId: 'recovery', quantityMm: 110.5 }] }];
    expect(planBarOwnershipRestoration(input)[0].assignments).toContainEqual({ reservationId: 'recovery', beforeMm: 0, afterMm: 110.5 });
  });
  it('allows another OF to use free stock without changing its holds', () => {
    const input = current(); input.bars[0] = { ...input.bars[0], lengthMm: 500, version: 9 };
    input.holds[2].remainingMm = 80;
    const changes = planBarOwnershipRestoration(input);
    expect(changes[0].bar).toMatchObject({ lengthMm: 500, version: 9 });
    expect(changes[0].assignments.some(a => a.reservationId === 'other')).toBe(false);
  });
  it('records and releases a surplus-only lot without inventing source holds', () => {
    const change = planBarOwnershipTransfer({ bars, holds: [held('b', 'producer', 50)], sourceIds: [], targetReservationId: 'producer' })[0];
    expect(planBarOwnershipRestoration({ bars, holds: [held('b', 'producer', 50)],
      proofs: [{ ...change.proof, version: 2 }], groups: [{ targetReservationId: 'producer', sources: [] }] })[0].assignments)
      .toEqual([{ reservationId: 'producer', beforeMm: 50, afterMm: 0 }]);
  });
  it.each(['unknown', 'duplicate', 'self'])('refuses invalid transfer identity: %s', kind => {
    const sourceIds = kind === 'unknown' ? ['missing'] : kind === 'duplicate' ? ['r1', 'r1'] : ['producer'];
    expect(() => planBarOwnershipTransfer({ bars, holds, sourceIds, targetReservationId: 'producer' })).toThrow(/affectations/);
  });
  it.each(['missingProof', 'changedQuantity', 'movedHold', 'sourceReused', 'duplicateProof', 'missingBar'])('refuses ambiguous restitution: %s', kind => {
    const input = current();
    if (kind === 'missingProof') input.proofs.pop();
    if (kind === 'changedQuantity') input.holds[0].remainingMm -= 1;
    if (kind === 'movedHold') { input.holds[0].remainingMm -= 1; input.holds[1].remainingMm += 1; }
    if (kind === 'sourceReused') input.holds.push(held('a', 'r1', 1));
    if (kind === 'duplicateProof') input.proofs.push(input.proofs[0]);
    if (kind === 'missingBar') input.bars.pop();
    expect(() => planBarOwnershipRestoration(input)).toThrow(/affectations/);
  });
});
