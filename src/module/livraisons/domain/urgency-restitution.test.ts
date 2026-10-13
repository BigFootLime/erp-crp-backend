import { describe, expect, it } from 'vitest';
import { planUrgencyRestitution } from './urgency-restitution';

const fixture = (): Parameters<typeof planUrgencyRestitution>[0] => ({ quantity: '10',
  recoveries: [{ id: 'recovery', quantity: '10', replenished: '0', donor_uncovered: '10' }],
  transfers: [{ id: 'transfer', recovery_id: 'recovery', reservation_id: 'reservation', quantity: '10' }],
  reservations: [{ id: 'reservation', remaining: '10', prepared: '0', consumed: '0', identity_valid: true, blocker: null }],
});

describe('restitution of withdrawn urgency stock', () => {
  it('returns the exact borrowed quantity to an uncovered donor', () => {
    expect(planUrgencyRestitution(fixture())).toMatchObject({ can_restore: true, donor_quantity: '10', free_quantity: '0' });
  });
  it('does not restore replacements already received from production twice', () => {
    const data = fixture(); data.recoveries[0].replenished = '4';
    expect(planUrgencyRestitution(data)).toMatchObject({ donor_quantity: '6', free_quantity: '4' });
  });
  it('caps donor restoration at its current uncovered demand', () => {
    const data = fixture(); data.recoveries[0].donor_uncovered = '3';
    expect(planUrgencyRestitution(data)).toMatchObject({ donor_quantity: '3', free_quantity: '7' });
  });
  it.each(['0', '10'])('preserves all returned pieces when donor coverage or repayment is complete (%s)', value => {
    const data = fixture(); data.recoveries[0].donor_uncovered = value; data.recoveries[0].replenished = '10';
    expect(planUrgencyRestitution(data)).toMatchObject({ donor_quantity: '0', free_quantity: '10' });
  });
  it('shares the remaining debt across transfers without allocating it twice', () => {
    const data = fixture(); data.recoveries[0].replenished = '3';
    data.transfers = [
      { ...data.transfers[0], id: 'b', quantity: '4' },
      { ...data.transfers[0], id: 'a', quantity: '6' },
    ];
    const result = planUrgencyRestitution(data);
    expect(result.lines.map(line => [line.transfer_id, line.donor_quantity, line.free_quantity])).toEqual([['a', '6', '0'], ['b', '1', '3']]);
    expect(result.donor_quantity).toBe('7'); expect(result.free_quantity).toBe('3');
  });
  it('sums transfers sharing one reservation before checking the remaining stock', () => {
    const data = fixture(); data.transfers = [ { ...data.transfers[0], quantity: '6' }, { ...data.transfers[0], id: 'b', quantity: '4' } ];
    data.reservations[0].remaining = '6';
    expect(planUrgencyRestitution(data)).toMatchObject({ can_restore: false, issues: [{ code: 'URGENCY_RETURN_SHORTAGE' }] });
  });
  it('requires physical return even if some non-shipped balance remains in the same reservation', () => {
    const data = fixture(); data.reservations[0].consumed = '2'; data.reservations[0].remaining = '20';
    expect(planUrgencyRestitution(data)).toMatchObject({ can_restore: false, issues: [{ code: 'URGENCY_RETURN_ALREADY_SHIPPED' }] });
  });
  it('requires removal from BL preparation before restitution', () => {
    const data = fixture(); data.reservations[0].prepared = '1';
    expect(planUrgencyRestitution(data)).toMatchObject({ can_restore: false, issues: [{ code: 'URGENCY_RETURN_PREPARED' }] });
  });
  it('never bypasses a current quality or physical stock blocker', () => {
    const data = fixture(); data.reservations[0].blocker = 'Lot bloqué par la qualité.';
    expect(planUrgencyRestitution(data)).toMatchObject({ can_restore: false, issues: [{ message: 'Lot bloqué par la qualité.' }] });
  });
  it.each(['missing', 'moved'])('requires matching lot and affair provenance (%s)', value => {
    const data = fixture(); if (value === 'missing') data.reservations = []; else data.reservations[0].identity_valid = false;
    expect(planUrgencyRestitution(data)).toMatchObject({ can_restore: false, issues: [{ code: 'URGENCY_RETURN_RESERVATION_CHANGED' }] });
  });
  it('keeps millesimal quantities exact', () => {
    const data = fixture(); data.quantity = '0.333'; data.recoveries = [{ id: 'recovery', quantity: '0.333', replenished: '0.111', donor_uncovered: '0.333' }];
    data.transfers[0].quantity = '0.333'; data.reservations[0].remaining = '0.333';
    expect(planUrgencyRestitution(data)).toMatchObject({ donor_quantity: '0.222', free_quantity: '0.111' });
  });
  it.each(['duplicate-transfer', 'duplicate-recovery', 'duplicate-reservation', 'missing-recovery', 'mismatched-total', 'over-repaid', 'invalid', 'negative', 'zero'])('rejects inconsistent history: %s', kind => {
    const data = fixture();
    if (kind === 'duplicate-transfer') data.transfers = [...data.transfers, data.transfers[0]];
    if (kind === 'duplicate-recovery') data.recoveries = [...data.recoveries, data.recoveries[0]];
    if (kind === 'duplicate-reservation') data.reservations = [...data.reservations, data.reservations[0]];
    if (kind === 'missing-recovery') data.recoveries = [];
    if (kind === 'mismatched-total') data.quantity = '9';
    if (kind === 'over-repaid') data.recoveries[0].replenished = '11';
    if (kind === 'invalid') data.quantity = '1,000';
    if (kind === 'negative') data.reservations[0].remaining = '-1';
    if (kind === 'zero') data.quantity = '0';
    expect(() => planUrgencyRestitution(data)).toThrow(expect.objectContaining({ code: 'URGENCY_RETURN_INCONSISTENT' }));
  });
  it('keeps independent donor debts separate when their pieces share one reservation', () => {
    const data = fixture(); data.recoveries = [
      { id: 'a', quantity: '4', replenished: '4', donor_uncovered: '10' },
      { id: 'b', quantity: '6', replenished: '0', donor_uncovered: '6' },
    ];
    data.transfers = [{ ...data.transfers[0], id: 'a', recovery_id: 'a', quantity: '4' },
      { ...data.transfers[0], id: 'b', recovery_id: 'b', quantity: '6' }];
    expect(planUrgencyRestitution(data).lines.map(line => [line.donor_quantity, line.free_quantity])).toEqual([['0', '4'], ['6', '0']]);
  });
});
