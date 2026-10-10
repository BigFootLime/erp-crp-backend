import { describe, expect, it } from 'vitest';
import { projectContractReplenishmentLots } from './client-contract-replenishment';

const month = (period: string, shortage: string, target: string) => ({
  month: period, missing_quantity: shortage, target_date: target,
});
const project = (shortages: string[], lot: string) => projectContractReplenishmentLots({
  months: shortages.map((shortage, index) => month(`2026-${String(index + 10).padStart(2, '0')}`, shortage,
    index === 0 ? '2026-09-30' : index === 1 ? '2026-10-31' : '2026-11-30')),
  replenishmentQty: lot, today: '2026-10-10',
});

describe('contract replenishment fixed lots', () => {
  it('proposes three fixed lots for a shortage of 95 with a lot of 40', () => {
    expect(project(['95'], '40')[0]).toMatchObject({
      lot_count: '3', proposed_quantity: '120', surplus_quantity: '25',
      target_date: '2026-09-30', target_overdue: true,
    });
  });

  it('carries proposed surplus forward instead of producing the cumulative shortage again', () => {
    const result = project(['17', '28', '5'], '20');
    expect(result.map(row => row.lot_count)).toEqual(['1', '2', '0']);
    expect(result.map(row => row.proposed_quantity)).toEqual(['20', '40', '0']);
    expect(result.map(row => row.carried_quantity)).toEqual(['0', '3', '5']);
    expect(result.map(row => row.surplus_quantity)).toEqual(['3', '15', '10']);
  });

  it('creates nothing for covered months and preserves unused surplus across a covered month', () => {
    expect(project(['5', '0', '14'], '20').map(row => row.proposed_quantity)).toEqual(['20', '0', '0']);
    expect(project(['0', '0'], '20').every(row => row.lot_count === '0')).toBe(true);
  });

  it('uses exact decimal arithmetic at a lot boundary', () => {
    const rows = project(['0.3', '0.000000000001'], '0.1');
    expect(rows.map(row => row.lot_count)).toEqual(['3', '1']);
    expect(rows[1].surplus_quantity).toBe('0.099999999999');
  });

  it('does not share a proposed surplus between distinct contract lines', () => {
    const first = project(['1'], '40');
    const second = project(['39'], '40');
    expect(first[0].proposed_quantity).toBe('40');
    expect(second[0].proposed_quantity).toBe('40');
  });

  it('is deterministic, preserves the input and keeps the historical target date', () => {
    const periods = Object.freeze([Object.freeze(month('2026-10', '95', '2026-09-30'))]);
    const input = { months: periods, replenishmentQty: '40', today: '2026-10-10' };
    expect(projectContractReplenishmentLots(input)).toEqual(projectContractReplenishmentLots(input));
    expect(periods[0].missing_quantity).toBe('95');
    expect(periods[0].target_date).toBe('2026-09-30');
  });

  it('rejects missing/negative lot sizes, negative shortages and repeated or reversed months', () => {
    expect(() => project(['1'], '0')).toThrow('CONTRACT_REPLENISHMENT_LOT_REQUIRED');
    expect(() => project(['1'], '-2')).toThrow();
    expect(() => project(['-1'], '2')).toThrow();
    expect(() => projectContractReplenishmentLots({
      months: [month('2026-11', '1', '2026-10-31'), month('2026-10', '1', '2026-09-30')],
      replenishmentQty: '2', today: '2026-10-10',
    })).toThrow('CONTRACT_REPLENISHMENT_MONTH_ORDER');
  });
});
