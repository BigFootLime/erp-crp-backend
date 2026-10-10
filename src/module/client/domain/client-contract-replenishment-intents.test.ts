import { describe, expect, it } from 'vitest';
import { allocateOpenContractReplenishmentIntents, type ContractReplenishmentOpenIntent } from './client-contract-replenishment-intents';
import type { ContractCoverageDemand, ContractCoverageSupply } from '../types/client-contract-coverage.types';

const demand = (id: string, quantity: string, contract = 'a'): ContractCoverageDemand => ({ id, kind: 'FORECAST',
  article_id: 'article-a', unit: 'U', contract_id: contract, contract_line_id: 'line-' + contract,
  order_line_id: null, allocation_id: null, quantity, due_date: '2026-10-31', month: '2026-10', target_date: '2026-09-30' });
const intent = (id: string, quantity: string): ContractReplenishmentOpenIntent => ({ id, article_id: 'article-a', unit: 'U',
  quantity, scrap_quantity: '0', received_quantity: '0', target_date: '2026-09-30', status: 'OPEN', coverage_source_ids: [] });
const source: ContractCoverageSupply = { id: 'production:1', kind: 'PRODUCTION', article_id: 'article-a', unit: 'U',
  quantity: '20', available_date: '2026-09-29', order_line_id: null, allocation_id: null, reference_id: '1', label: 'OF-001' };
const base = { sources: [], allocations: [] };
describe('existing replenishment production intentions', () => {
  it('does not propose the same 20 pieces again when a draft exists, while retaining the real delivery shortage elsewhere', () => {
    const demands = Object.freeze([Object.freeze(demand('a', '17'))]);
    const result = allocateOpenContractReplenishmentIntents({ ...base, demands, intents: [intent('draft-1', '20')] });
    expect(result.outstanding_demands[0].quantity).toBe('0');
    expect(result.allocations).toEqual([{ demand_id: 'a', intent_id: 'draft-1', quantity: '17', target_review_required: false }]);
    expect(result.unassigned_intents[0].quantity).toBe('3');
    expect(demands[0].quantity).toBe('17');
  });
  it('spends a common draft once across competing contracts, preserving their actual chronological priorities', () => {
    const result = allocateOpenContractReplenishmentIntents({ ...base,
      demands: [demand('b', '15', 'b'), demand('a', '15')], intents: [intent('draft-1', '20')] });
    expect(result.outstanding_demands.map(row => [row.id, row.quantity])).toEqual([['a', '0'], ['b', '10']]);
    expect(result.allocations.map(row => row.quantity)).toEqual(['15', '5']);
  });
  it('subtracts secured production already allocated to another contract before reusing its intention', () => {
    const generated = { ...intent('root-1', '20'), coverage_source_ids: [source.id] };
    const result = allocateOpenContractReplenishmentIntents({ sources: [source],
      demands: [demand('a', '15'), demand('b', '10', 'b')], allocations: [{ demand_id: 'b', source_id: source.id, kind: 'PRODUCTION', quantity: '10' }],
      intents: [generated] });
    expect(result.outstanding_demands.map(row => [row.id, row.quantity])).toEqual([['a', '5'], ['b', '0']]);
    expect(result.allocations.map(row => row.quantity)).toEqual(['10']);
  });
  it('does not confuse a later target with a secured delivery or silently duplicate the late OF', () => {
    const result = allocateOpenContractReplenishmentIntents({ ...base, demands: [demand('a', '17')],
      intents: [{ ...intent('draft-1', '20'), target_date: '2026-10-31' }] });
    expect(result.outstanding_demands[0].quantity).toBe('0');
    expect(result.allocations[0].target_review_required).toBe(true);
  });
  it('allows a replacement for an explicitly cancelled empty OF, and subtracts final scrap exactly', () => {
    const result = allocateOpenContractReplenishmentIntents({ ...base, demands: [demand('a', '0.3')],
      intents: [{ ...intent('cancelled', '10'), status: 'CANCELLED' }, { ...intent('open', '0.3'), scrap_quantity: '0.1' }] });
    expect(result.allocations.map(row => row.intent_id)).toEqual(['open']);
    expect(result.outstanding_demands[0].quantity).toBe('0.1');
  });
  it('requires reconciliation for received or grouped/ambiguous output rather than automatically launching duplicate stock', () => {
    for (const unsupported of [{ ...intent('root-1', '20'), received_quantity: '1' }, { ...intent('root-1', '20'), status: 'REVIEW_REQUIRED' as const }])
      expect(() => allocateOpenContractReplenishmentIntents({ ...base, demands: [demand('a', '17')], intents: [unsupported] }))
        .toThrow('des pièces reçues ou une affectation à rapprocher');
  });
  it('rejects repeated ownership, duplicate identities and over-allocation proofs', () => {
    const input = { demands: [demand('a', '17')], sources: [source], allocations: [],
      intents: [{ ...intent('root-1', '20'), coverage_source_ids: [source.id] }, { ...intent('root-2', '20'), coverage_source_ids: [source.id] }] };
    expect(() => allocateOpenContractReplenishmentIntents(input)).toThrow('plusieurs OF');
    expect(() => allocateOpenContractReplenishmentIntents({ ...input, intents: [intent('same', '1'), intent('same', '1')] })).toThrow('plusieurs fois');
    expect(() => allocateOpenContractReplenishmentIntents({ ...input,
      allocations: [{ demand_id: 'a', source_id: source.id, kind: 'PRODUCTION', quantity: '18' }] })).toThrow('dépasse la quantité');
  });
  it('rejects counted production bound to another delivery or arriving too late', () => {
    const allocation = { demand_id: 'a', source_id: source.id, kind: 'PRODUCTION' as const, quantity: '1' };
    for (const incompatible of [{ ...source, order_line_id: 'other-line' }, { ...source, allocation_id: 'other-allocation' },
      { ...source, available_date: '2026-10-31' }, { ...source, available_date: null }])
      expect(() => allocateOpenContractReplenishmentIntents({ demands: [demand('a', '17')], sources: [incompatible],
        allocations: [allocation], intents: [intent('draft-1', '20')] })).toThrow('cette livraison ou cette date');
  });
});
