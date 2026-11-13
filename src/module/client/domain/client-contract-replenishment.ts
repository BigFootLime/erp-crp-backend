import { formatCumpDecimal, parseCumpDecimal } from '../../stock/domain/cump-decimal';
import type { ContractCoverageMonth } from '../types/client-contract-coverage.types';

/** Proposed lots are planning quantities, never physical or reserved stock. */
export type ContractReplenishmentMonth = {
  month: string;
  target_date: string;
  uncovered_quantity: string;
  carried_quantity: string;
  lot_count: string;
  lot_quantity: string;
  proposed_quantity: string;
  surplus_quantity: string;
  target_overdue: boolean;
};

/**
 * The caller supplies the net monthly shortages after the shared coverage
 * allocation. Each contract line has its own projection: proposed surplus is
 * carried forward once, without treating a draft OF as available supply.
 */
export function projectContractReplenishmentLots(input: {
  months: readonly Pick<ContractCoverageMonth, 'month' | 'target_date' | 'missing_quantity'>[];
  replenishmentQty: string;
  today: string;
}): ContractReplenishmentMonth[] {
  const lot = parseCumpDecimal(input.replenishmentQty);
  if (lot <= 0n) throw new Error('CONTRACT_REPLENISHMENT_LOT_REQUIRED');
  let surplus = 0n;
  let previousMonth = '';
  return input.months.map(period => {
    if (period.month <= previousMonth) throw new Error('CONTRACT_REPLENISHMENT_MONTH_ORDER');
    previousMonth = period.month;
    const shortage = parseCumpDecimal(period.missing_quantity);
    const carried = shortage < surplus ? shortage : surplus;
    surplus -= carried;
    const uncovered = shortage - carried;
    const count = uncovered === 0n ? 0n : (uncovered + lot - 1n) / lot;
    const quantity = count * lot;
    surplus += quantity - uncovered;
    return {
      month: period.month,
      target_date: period.target_date,
      uncovered_quantity: formatCumpDecimal(uncovered),
      carried_quantity: formatCumpDecimal(carried),
      lot_count: count.toString(),
      lot_quantity: formatCumpDecimal(lot),
      proposed_quantity: formatCumpDecimal(quantity),
      surplus_quantity: formatCumpDecimal(surplus),
      target_overdue: count > 0n && period.target_date < input.today,
    };
  });
}
