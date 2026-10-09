import { formatCumpDecimal, parseCumpDecimal } from '../../stock/domain/cump-decimal';
import type {
  ContractCoverageAllocation, ContractCoverageDemand, ContractCoverageMonth,
  ContractCoverageSupply, CoveragePeriod,
} from '../types/client-contract-coverage.types';

const minimum = (a: bigint, b: bigint) => a < b ? a : b;

/** A shared source is spent once across all contracts and ordinary firm orders. */
export function allocateContractCoverage(
  demands: readonly ContractCoverageDemand[], sources: readonly ContractCoverageSupply[],
): ContractCoverageAllocation[] {
  const ids = new Set<string>();
  const remaining = new Map<string, bigint>();
  for (const source of sources) {
    if (ids.has(source.id)) throw new Error('CONTRACT_COVERAGE_DUPLICATE_SOURCE');
    ids.add(source.id); remaining.set(source.id, parseCumpDecimal(source.quantity));
  }
  const demandIds = new Set<string>();
  const ordered = [...demands].sort((a, b) => a.target_date.localeCompare(b.target_date)
    || (a.kind === b.kind ? 0 : a.kind === 'FIRM' ? -1 : 1) || a.id.localeCompare(b.id));
  const available = [...sources].sort((a, b) =>
    (a.order_line_id === null ? 1 : 0) - (b.order_line_id === null ? 1 : 0)
    || (a.kind === b.kind ? 0 : a.kind === 'RESERVED' ? -1 : b.kind === 'RESERVED' ? 1 : a.kind === 'FREE' ? -1 : 1)
    || (a.available_date ?? '').localeCompare(b.available_date ?? '') || a.id.localeCompare(b.id));
  const byArticle = new Map<string, ContractCoverageSupply[]>();
  for (const source of available) {
    const key = `${source.article_id}:${source.unit}`, entries = byArticle.get(key) ?? [];
    entries.push(source); byArticle.set(key, entries);
  }
  const allocations: ContractCoverageAllocation[] = [];
  for (const demand of ordered) {
    if (demandIds.has(demand.id)) throw new Error('CONTRACT_COVERAGE_DUPLICATE_DEMAND');
    demandIds.add(demand.id);
    let needed = parseCumpDecimal(demand.quantity);
    for (const source of byArticle.get(`${demand.article_id}:${demand.unit}`) ?? []) {
      if (!needed) break;
      if (source.article_id !== demand.article_id || source.unit !== demand.unit) continue;
      if (source.order_line_id !== null && source.order_line_id !== demand.order_line_id) continue;
      if (source.allocation_id !== null && source.allocation_id !== demand.allocation_id) continue;
      if (source.kind === 'PRODUCTION' && (!source.available_date || source.available_date > demand.target_date)) continue;
      const quantity = minimum(needed, remaining.get(source.id)!);
      if (!quantity) continue;
      allocations.push({ demand_id: demand.id, source_id: source.id, kind: source.kind, quantity: formatCumpDecimal(quantity) });
      needed -= quantity; remaining.set(source.id, remaining.get(source.id)! - quantity);
    }
  }
  return allocations;
}

export function projectContractCoverageMonths(input: {
  periods: readonly CoveragePeriod[]; today: string;
  demands: readonly ContractCoverageDemand[]; allocations: readonly ContractCoverageAllocation[];
}): ContractCoverageMonth[] {
  const byDemand = new Map<string, ContractCoverageAllocation[]>();
  for (const allocation of input.allocations) {
    const entries = byDemand.get(allocation.demand_id) ?? [];
    entries.push(allocation); byDemand.set(allocation.demand_id, entries);
  }
  let cumulativeDemand = 0n, cumulativeCovered = 0n;
  return input.periods.map((period, index) => {
    const selected = input.demands.filter(demand => demand.month === period.month
      || (index === 0 && demand.month < period.month));
    let forecast = 0n, firm = 0n, reserved = 0n, free = 0n, production = 0n;
    for (const demand of selected) {
      const quantity = parseCumpDecimal(demand.quantity);
      if (demand.kind === 'FIRM') firm += quantity; else forecast += quantity;
      for (const allocation of byDemand.get(demand.id) ?? []) {
        const covered = parseCumpDecimal(allocation.quantity);
        if (allocation.kind === 'RESERVED') reserved += covered;
        else if (allocation.kind === 'FREE') free += covered;
        else production += covered;
      }
    }
    const covered = reserved + free + production;
    cumulativeDemand += forecast + firm; cumulativeCovered += covered;
    return { ...period, forecast_quantity: formatCumpDecimal(forecast), firm_quantity: formatCumpDecimal(firm),
      reserved_quantity: formatCumpDecimal(reserved), free_quantity: formatCumpDecimal(free),
      production_quantity: formatCumpDecimal(production), missing_quantity: formatCumpDecimal(forecast + firm - covered),
      cumulative_demand: formatCumpDecimal(cumulativeDemand), cumulative_covered: formatCumpDecimal(cumulativeCovered),
      cumulative_missing: formatCumpDecimal(cumulativeDemand - cumulativeCovered),
      target_overdue: selected.some(demand => demand.target_date < input.today && parseCumpDecimal(demand.quantity) > 0n) };
  });
}
