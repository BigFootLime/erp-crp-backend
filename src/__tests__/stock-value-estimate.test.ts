import { describe, expect, it } from 'vitest';
import { estimateStockValue } from '../module/stock-intelligence/domain/stock-value-estimate';

const known = { costsVisible: true, physical: 10, depreciated: 2, latestUnitCost: 5,
  currency: 'EUR', currencyCount: 1, unitCompatible: true };
describe('stock value evidence — prepared for final acceptance', () => {
  it('publishes a last-cost estimate and preserves the missing CUMP ledger', () => {
    expect(estimateStockValue(known)).toEqual({ value: 40, missing: ['COST_LAYER_NOT_MATERIALIZED'] });
    expect(estimateStockValue({ ...known, latestUnitCost: 0 }).value).toBe(0);
  });
  it.each([null, -1, Number.NaN, Number.POSITIVE_INFINITY])('does not replace an unknown/invalid price %s with zero', price => {
    expect(estimateStockValue({ ...known, latestUnitCost: price })).toMatchObject({ value: null,
      missing: expect.arrayContaining(['LATEST_MOVEMENT_UNIT_COST_EVIDENCE']) });
  });
  it('does not multiply a price by another stock unit or mix currencies', () => {
    expect(estimateStockValue({ ...known, unitCompatible: false }).value).toBeNull();
    expect(estimateStockValue({ ...known, currency: null }).value).toBeNull();
    expect(estimateStockValue({ ...known, currencyCount: 2 }).value).toBeNull();
    expect(estimateStockValue({ ...known, latestOrderAmbiguous: true }).value).toBeNull();
  });
  it('does not turn incoherent physical/depreciated quantities into a negative asset', () => {
    expect(estimateStockValue({ ...known, depreciated: 11 }).value).toBeNull();
    expect(estimateStockValue({ ...known, physical: -1 }).value).toBeNull();
  });
  it('does not disclose cost evidence to a caller without the cost permission', () => {
    expect(estimateStockValue({ ...known, costsVisible: false, latestUnitCost: -1 })).toEqual({ value: null,
      missing: ['COST_PERMISSION_REQUIRED'] });
  });
});
