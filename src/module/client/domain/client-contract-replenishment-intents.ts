import { HttpError } from '../../../utils/httpError';
import { formatCumpDecimal, parseCumpDecimal } from '../../stock/domain/cump-decimal';
import type { ContractCoverageAllocation, ContractCoverageDemand, ContractCoverageSupply } from '../types/client-contract-coverage.types';

/** An already created root holds a production intention, never available stock. */
export type ContractReplenishmentOpenIntent = {
  id: string; article_id: string; unit: string; quantity: string; scrap_quantity: string; received_quantity: string;
  target_date: string; status: 'OPEN' | 'CANCELLED' | 'REVIEW_REQUIRED';
  /** Authoritatively reconciled source identities of this producer, not caller-provided aliases. */
  coverage_source_ids: readonly string[];
};
export type ContractReplenishmentIntentAllocation = {
  demand_id: string; intent_id: string; quantity: string; target_review_required: boolean;
};

/**
 * Spend each existing production intention once against shortages left by the
 * actual shared coverage allocation. Subtract its already counted production
 * coverage first. The result guides additional proposals, not delivery promises.
 * Received/grouped/ambiguous roots must be reconciled before using this adapter.
 */
export function allocateOpenContractReplenishmentIntents(input: {
  demands: readonly ContractCoverageDemand[]; sources: readonly ContractCoverageSupply[];
  allocations: readonly ContractCoverageAllocation[]; intents: readonly ContractReplenishmentOpenIntent[];
}) {
  const fail = (message: string): never => { throw new HttpError(409, 'CONTRACT_REPLENISHMENT_INTENT_REVIEW_REQUIRED', message); };
  const sourceById = new Map(input.sources.map(source => [source.id, source]));
  const demandById = new Map(input.demands.map(demand => [demand.id, demand]));
  if (sourceById.size !== input.sources.length || demandById.size !== input.demands.length)
    fail('Des identités de couverture sont dupliquées. Recalculez les besoins.');
  const coveredDemand = new Map<string, bigint>(), spentSource = new Map<string, bigint>();
  for (const allocation of input.allocations) {
    const source = sourceById.get(allocation.source_id), demand = demandById.get(allocation.demand_id);
    if (!source || !demand || source.article_id !== demand.article_id || source.unit !== demand.unit || source.kind !== allocation.kind)
      fail('Une affectation ne correspond plus à sa source ou à son besoin. Recalculez.');
    if ((source!.order_line_id !== null && source!.order_line_id !== demand!.order_line_id)
      || (source!.allocation_id !== null && source!.allocation_id !== demand!.allocation_id)
      || (source!.kind === 'PRODUCTION' && (!source!.available_date || source!.available_date > demand!.target_date)))
      fail('Une affectation n’est plus disponible pour cette livraison ou cette date. Recalculez.');
    const quantity = parseCumpDecimal(allocation.quantity);
    coveredDemand.set(demand!.id, (coveredDemand.get(demand!.id) ?? 0n) + quantity);
    spentSource.set(source!.id, (spentSource.get(source!.id) ?? 0n) + quantity);
    if (coveredDemand.get(demand!.id)! > parseCumpDecimal(demand!.quantity) || spentSource.get(source!.id)! > parseCumpDecimal(source!.quantity))
      fail('La couverture dépasse la quantité de sa source ou de son besoin. Recalculez.');
  }
  const ids = new Set<string>(), owners = new Set<string>(), remaining = new Map<string, bigint>();
  const active = [...input.intents].sort((a, b) => a.target_date.localeCompare(b.target_date) || a.id.localeCompare(b.id));
  for (const intent of active) {
    if (ids.has(intent.id)) fail('Un OF de réapprovisionnement apparaît plusieurs fois.');
    ids.add(intent.id);
    if (intent.status === 'REVIEW_REQUIRED' || parseCumpDecimal(intent.received_quantity) !== 0n)
      fail('Un OF déjà créé a des pièces reçues ou une affectation à rapprocher. Vérifiez cet OF avant une nouvelle génération.');
    if (intent.status === 'CANCELLED') { remaining.set(intent.id, 0n); continue; }
    const launched = parseCumpDecimal(intent.quantity), scrap = parseCumpDecimal(intent.scrap_quantity);
    if (scrap > launched) fail('La perte déclarée dépasse la quantité de l’OF.');
    let alreadyCounted = 0n;
    for (const sourceId of intent.coverage_source_ids) {
      const source = sourceById.get(sourceId);
      if (owners.has(sourceId) || !source || source.kind !== 'PRODUCTION' || source.article_id !== intent.article_id || source.unit !== intent.unit)
        fail('Une source de production est attribuée à plusieurs OF ou n’est plus compatible.');
      owners.add(sourceId); alreadyCounted += spentSource.get(sourceId) ?? 0n;
    }
    if (alreadyCounted > launched - scrap) fail('L’OF a déjà couvert davantage que sa quantité restante.');
    remaining.set(intent.id, launched - scrap - alreadyCounted);
  }
  const allocations: ContractReplenishmentIntentAllocation[] = [];
  const outstanding = [...input.demands].sort((a, b) => a.target_date.localeCompare(b.target_date)
    || (a.kind === b.kind ? 0 : a.kind === 'FIRM' ? -1 : 1) || a.id.localeCompare(b.id)).map(demand => {
    let needed = parseCumpDecimal(demand.quantity) - (coveredDemand.get(demand.id) ?? 0n);
    for (const intent of active) {
      if (!needed) break;
      if (intent.status !== 'OPEN' || intent.article_id !== demand.article_id || intent.unit !== demand.unit) continue;
      const available = remaining.get(intent.id)!;
      const accepted = needed < available ? needed : available;
      if (!accepted) continue;
      remaining.set(intent.id, available - accepted); needed -= accepted;
      allocations.push({ demand_id: demand.id, intent_id: intent.id, quantity: formatCumpDecimal(accepted),
        target_review_required: intent.target_date > demand.target_date });
    }
    return { ...demand, quantity: formatCumpDecimal(needed) };
  });
  return { allocations, outstanding_demands: outstanding,
    unassigned_intents: active.map(intent => ({ intent_id: intent.id, quantity: formatCumpDecimal(remaining.get(intent.id)!) })) };
}
