import { describe, expect, it } from 'vitest';
import { allocateContractCoverage, projectContractCoverageMonths } from './client-contract-coverage';
import { projectContractReplenishmentLots } from './client-contract-replenishment';
import { prepareContractReplenishmentWithIntents } from './client-contract-replenishment-intent-preparation';
import type { ContractCoverageDemand, ContractCoverageResult, ContractCoverageSupply } from '../types/client-contract-coverage.types';
import type { ContractReplenishmentOpenIntent } from './client-contract-replenishment-intents';

const today = '2026-10-10';
const article = { article_id: '00000000-0000-4000-8000-000000000001', root_article_id: '00000000-0000-4000-8000-000000000002',
  piece_technique_id: '00000000-0000-4000-8000-000000000003', piece_technique_version_id: '00000000-0000-4000-8000-000000000004',
  unit_id: '00000000-0000-4000-8000-000000000005', unit: 'U', code: 'PF-AXE', designation: 'Axe', indice: 'A' };
const periods = [
  { month: '2026-10', target_date: '2026-09-30', end_date: '2026-10-31' },
  { month: '2026-11', target_date: '2026-10-31', end_date: '2026-11-30' },
  { month: '2026-12', target_date: '2026-11-30', end_date: '2026-12-31' },
];
const demand = (id: string, quantity: string, period = 0, contract = 'contract-a'): ContractCoverageDemand => ({ id,
  article_id: article.article_id, unit: 'U', quantity, kind: 'FORECAST', contract_id: contract,
  contract_line_id: 'line-' + contract, order_line_id: null, allocation_id: null,
  month: periods[period].month, target_date: periods[period].target_date, due_date: periods[period].end_date });
const intent = (id: string, quantity = '20'): ContractReplenishmentOpenIntent => ({ id, article_id: article.article_id,
  unit: 'U', quantity, scrap_quantity: '0', received_quantity: '0', target_date: '2026-09-30', status: 'OPEN', coverage_source_ids: [] });
function snapshot(allDemands: ContractCoverageDemand[], allSources: ContractCoverageSupply[] = []) {
  const allAllocations = allocateContractCoverage(allDemands, allSources);
  const demands = allDemands.filter(item => item.contract_id === 'contract-a');
  const months = projectContractCoverageMonths({ periods, today, demands, allocations: allAllocations });
  const report: ContractCoverageResult = { contract_id: 'contract-a', contract_version: 1, generated_at: '2026-10-10T06:00:00Z',
    planning_revision: null, start_month: '2026-10', months: 3, readonly: true, snapshot_hash: 'a'.repeat(64),
    demands, sources: allSources, allocations: allAllocations.filter(a => demands.some(d => d.id === a.demand_id)), issues: [],
    lines: [{ contract_line_id: 'line-contract-a', article, replenishment_qty: '20', months,
      replenishment_projection: projectContractReplenishmentLots({ months, today, replenishmentQty: '20' }) }] };
  return { report, today, allDemands, allSources, allAllocations };
}
describe('launch proposal preparation with shared draft intentions', () => {
  it('retains actual delivery shortage 17/28/5 while proposing only the additional 40 after an existing draft of20', () => {
    const input = snapshot([demand('oct', '17'), demand('nov', '28', 1), demand('dec', '5', 2)]);
    const before = JSON.stringify(input.report);
    const result = prepareContractReplenishmentWithIntents({ ...input, intents: [intent('draft-1')] });
    expect(result.proposals.map(p => [p.month, p.proposed_quantity])).toEqual([['2026-11', '40']]);
    expect(result.report.lines[0].months.map(m => m.cumulative_missing)).toEqual(['17', '45', '50']);
    expect(JSON.stringify(input.report)).toBe(before);
    expect(result.current_contract_intent_allocations.map(a => a.quantity)).toEqual(['17', '3']);
  });
  it('does not propose again when the existing intentions already total60, even without secured planning', () => {
    const input = snapshot([demand('oct', '17'), demand('nov', '28', 1), demand('dec', '5', 2)]);
    const result = prepareContractReplenishmentWithIntents({ ...input, intents: [intent('draft-1'), intent('draft-2', '40')] });
    expect(result.proposals).toEqual([]);
    expect(result.intent_context.unassigned_intents.map(a => a.quantity)).toEqual(['0', '10']);
    expect(result.report.lines[0].months.at(-1)?.cumulative_missing).toBe('50');
  });
  it('allocates one shared draft across competing contracts before preparing the selected contract', () => {
    const input = snapshot([demand('a', '15'), { ...demand('b', '15', 0, 'contract-b'), kind: 'FIRM' as const }]);
    const result = prepareContractReplenishmentWithIntents({ ...input, intents: [intent('draft-1')] });
    expect(result.current_contract_intent_allocations.map(a => a.quantity)).toEqual(['5']);
    expect(result.proposals.map(p => p.proposed_quantity)).toEqual(['20']);
    expect(result.intent_context.allocations.map(a => [a.demand_id, a.quantity])).toEqual([['b', '15'], ['a', '5']]);
  });
  it('does not spend an already counted on-time producer a second time', () => {
    const production: ContractCoverageSupply = { id: 'production:1', kind: 'PRODUCTION', article_id: article.article_id,
      unit: 'U', quantity: '20', available_date: '2026-09-29', order_line_id: null, allocation_id: null, reference_id: '1', label: 'OF-001' };
    const input = snapshot([demand('oct', '17'), demand('nov', '28', 1), demand('dec', '5', 2)], [production]);
    const result = prepareContractReplenishmentWithIntents({ ...input, intents: [{ ...intent('root-1'), coverage_source_ids: [production.id] }] });
    expect(result.current_contract_intent_allocations).toEqual([]);
    expect(result.proposals.map(p => p.proposed_quantity)).toEqual(['40']);
  });
  it('changes the freshness fingerprint when an intention changes without changing physical coverage', () => {
    const input = snapshot([demand('oct', '17')]);
    const first = prepareContractReplenishmentWithIntents({ ...input, intents: [intent('draft-1')] });
    const changed = prepareContractReplenishmentWithIntents({ ...input, intents: [intent('draft-1', '40')] });
    expect(first.report.snapshot_hash).toBe(changed.report.snapshot_hash);
    expect(first.fingerprint).not.toBe(changed.fingerprint);
    expect(first.intent_fingerprint).not.toBe(changed.intent_fingerprint);
    expect(prepareContractReplenishmentWithIntents({ ...input, intents: [intent('draft-1')] }).fingerprint).toBe(first.fingerprint);
  });
  it('keeps the passed original target and surfaces a later existing intention for planning review', () => {
    const input = snapshot([demand('oct', '25')]);
    const result = prepareContractReplenishmentWithIntents({ ...input, intents: [{ ...intent('late'), target_date: '2026-10-31' }] });
    expect(result.current_contract_intent_allocations[0].target_review_required).toBe(true);
    expect(result.proposals).toMatchObject([{ target_date: '2026-09-30', target_overdue: true, proposed_quantity: '20' }]);
  });
  it('requires a matching shared demand scope and reconciled received/grouped identities', () => {
    const input = snapshot([demand('oct', '17')]);
    expect(() => prepareContractReplenishmentWithIntents({ ...input, allDemands: [], intents: [] })).toThrow('périmètre partagé');
    expect(() => prepareContractReplenishmentWithIntents({ ...input, allDemands: [{ ...input.allDemands[0], quantity: '1' }], intents: [] })).toThrow('périmètre partagé');
    expect(() => prepareContractReplenishmentWithIntents({ ...input, intents: [{ ...intent('received'), received_quantity: '1' }] })).toThrow('des pièces reçues');
  });
});
