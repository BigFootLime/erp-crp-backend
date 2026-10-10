import { createHash } from 'node:crypto';
import { HttpError } from '../../../utils/httpError';
import { projectContractCoverageMonths } from './client-contract-coverage';
import { projectContractReplenishmentLots } from './client-contract-replenishment';
import { prepareContractReplenishmentSnapshot } from './client-contract-replenishment-preparation';
import { allocateOpenContractReplenishmentIntents, type ContractReplenishmentOpenIntent } from './client-contract-replenishment-intents';
import type { ContractCoverageAllocation, ContractCoverageDemand, ContractCoverageResult, ContractCoverageSupply } from '../types/client-contract-coverage.types';

/** Keep the delivery report intact. Draft intentions only reduce additional launches.
 * All contracts competing for these articles must be allocated before selecting
 * the current contract; a per-contract draft budget would count the same OF twice.
 * The persistence adapter must supply reconciled producer identities, not aliases.
 */
export function prepareContractReplenishmentWithIntents(input: {
  report: ContractCoverageResult; today: string;
  allDemands: readonly ContractCoverageDemand[]; allSources: readonly ContractCoverageSupply[];
  allAllocations: readonly ContractCoverageAllocation[]; intents: readonly ContractReplenishmentOpenIntent[];
}) {
  const { report } = input;
  const selected = input.allDemands.filter(demand => demand.contract_id === report.contract_id);
  const selectedById = new Map(selected.map(demand => [demand.id, demand]));
  const selectedIds = new Set(selectedById.keys());
  const identity = (demand: ContractCoverageDemand) => JSON.stringify([demand.id, demand.kind, demand.article_id, demand.unit,
    demand.contract_id, demand.contract_line_id, demand.order_line_id, demand.allocation_id, demand.quantity,
    demand.due_date, demand.month, demand.target_date]);
  if (selected.length !== report.demands.length || report.demands.some(demand => {
    const shared = selectedById.get(demand.id);
    return !shared || identity(shared) !== identity(demand);
  }))
    throw new HttpError(409, 'CONTRACT_REPLENISHMENT_INTENT_REVIEW_REQUIRED', 'Le périmètre partagé des besoins a changé. Recalculez.');
  const hold = allocateOpenContractReplenishmentIntents({ demands: input.allDemands, sources: input.allSources,
    allocations: input.allAllocations, intents: input.intents });
  // There is no alternate delivery coverage: the original sources and totals
  // remain authoritative for availability, OTD and delivery promises.
  const lines = report.lines.map(line => {
    const net = projectContractCoverageMonths({ periods: line.months, today: input.today, allocations: [],
      demands: hold.outstanding_demands.filter(demand => selectedIds.has(demand.id) && demand.contract_line_id === line.contract_line_id) });
    return { ...line, replenishment_projection: projectContractReplenishmentLots({ months: net,
      today: input.today, replenishmentQty: line.replenishment_qty }) };
  });
  const preparation = prepareContractReplenishmentSnapshot({ ...report, lines }, input.today);
  const intentContext = {
    intents: [...input.intents].sort((a, b) => a.id.localeCompare(b.id)).map(intent => ({ ...intent,
      coverage_source_ids: [...intent.coverage_source_ids].sort() })),
    allocations: hold.allocations,
    outstanding_demands: hold.outstanding_demands,
    unassigned_intents: hold.unassigned_intents,
  };
  const intentFingerprint = createHash('sha256').update(JSON.stringify(intentContext)).digest('hex');
  return { ...preparation,
    fingerprint: createHash('sha256').update(JSON.stringify({ preparation: preparation.fingerprint, intent: intentFingerprint })).digest('hex'),
    intent_fingerprint: intentFingerprint,
    intent_context: intentContext,
    current_contract_intent_allocations: hold.allocations.filter(allocation => selectedIds.has(allocation.demand_id)),
  };
}
