import { roundStockMetric } from './stock-intelligence';

/** A last-movement estimate is deliberately separate from a CUMP valuation. */
export function estimateStockValue(input: {
  costsVisible: boolean;
  physical: number;
  depreciated: number;
  latestUnitCost: number | null;
  currency: string | null;
  currencyCount: number;
  unitCompatible: boolean;
  latestOrderAmbiguous?: boolean;
}) {
  if (!input.costsVisible) return { value: null, missing: ['COST_PERMISSION_REQUIRED'] };
  const missing: string[] = [];
  if (input.latestUnitCost === null || !Number.isFinite(input.latestUnitCost) || input.latestUnitCost < 0) {
    missing.push('LATEST_MOVEMENT_UNIT_COST_EVIDENCE');
  }
  if (!input.currency || !/^[A-Z]{3}$/.test(input.currency)) missing.push('COST_CURRENCY_EVIDENCE');
  if (input.currencyCount > 1) missing.push('COST_CURRENCY_CONFLICT');
  if (!input.unitCompatible) missing.push('COST_STOCK_UNIT_EVIDENCE');
  if (input.latestOrderAmbiguous) missing.push('LATEST_MOVEMENT_ORDER_AMBIGUOUS');
  if (!Number.isFinite(input.physical) || !Number.isFinite(input.depreciated)
    || input.physical < 0 || input.depreciated < 0 || input.depreciated > input.physical) {
    missing.push('STOCK_QUANTITY_EVIDENCE');
  }
  const value = missing.length ? null : roundStockMetric((input.physical - input.depreciated) * input.latestUnitCost!, 2);
  if (value !== null && !Number.isFinite(value)) return { value: null, missing: ['STOCK_VALUE_OUT_OF_RANGE'] };
  return { value, missing: [...missing, 'COST_LAYER_NOT_MATERIALIZED'] };
}
