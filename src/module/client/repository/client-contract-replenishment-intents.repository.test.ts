import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { ContractCoverageSupply } from '../types/client-contract-coverage.types';
import { readReplenishmentProducerIntents, reconcileReplenishmentProducerIdentities, type ReplenishmentProducerIdentity } from './client-contract-replenishment-intents.repository';
import { allocateOpenContractReplenishmentIntents } from '../domain/client-contract-replenishment-intents';

const root = (overrides: Partial<ReplenishmentProducerIdentity> = {}): ReplenishmentProducerIdentity => ({
  evidence_id: 'evidence-1', root_of_id: '101', article_id: 'article-1', root_article_id: 'article-1', unit: 'U', root_unit: 'U',
  target_date: '2026-09-30', quantity: '20.000', scrap: '0', received: '0', released_attributed: '0', status: 'BROUILLON', order_line_id: null,
  group_id: null, share_id: null, producer_id: null, producer_article_id: null, producer_unit: null, producer_status: null,
  producer_scrap: null, producer_received: null, producer_attributed: null, share_quantity: null, share_received: null,
  root_identity_valid: true, producer_identity_valid: null, ...overrides,
});
const group = (overrides: Partial<ReplenishmentProducerIdentity> = {}) => root({ group_id: 'group-1', share_id: 'share-1',
  producer_id: '201', producer_article_id: 'article-1', producer_unit: 'U', producer_status: 'PLANIFIE', producer_scrap: '0',
  producer_received: '0', producer_attributed: '0', share_quantity: '20', share_received: '0', producer_identity_valid: true, ...overrides });
const source = (id = 'production:101'): ContractCoverageSupply => ({ id, kind: 'PRODUCTION', article_id: 'article-1', unit: 'U',
  quantity: '20', available_date: '2026-09-29', order_line_id: null, allocation_id: null, reference_id: '101', label: 'OF-101' });
const demand = { id: 'demand-1', kind: 'FORECAST' as const, article_id: 'article-1', unit: 'U', quantity: '20',
  contract_id: 'contract-1', contract_line_id: 'line-1', order_line_id: null, allocation_id: null,
  due_date: '2026-10-31', target_date: '2026-09-30', month: '2026-10' };

describe('persistent anticipated producer reconciliation', () => {
  it('uses the exact ungrouped canonical source identity and no browser aliases', () => {
    const rows = reconcileReplenishmentProducerIdentities([root()], [source(), source('production:101:alias')]);
    expect(rows[0]).toMatchObject({ id: 'evidence-1', quantity: '20.000', status: 'OPEN', received_reconciled: true,
      target_date: '2026-09-30', coverage_source_ids: ['production:101'] });
  });

  it('maps each grouped root only to its active producer share, excluding original and surplus aliases', () => {
    const canonical = { ...source('production:201:share:share-1'), reference_id: '201' };
    const result = reconcileReplenishmentProducerIdentities([group()], [source(), canonical,
      { ...source('production:201:surplus'), reference_id: '201' }]);
    expect(result[0].coverage_source_ids).toEqual(['production:201:share:share-1']);
  });

  it('retires received output only after immutable attribution, even when its physical stock was later consumed', () => {
    const intents = reconcileReplenishmentProducerIdentities([root({ received: '20', released_attributed: '20', status: 'CLOTURE' })], []);
    const calculated = allocateOpenContractReplenishmentIntents({ demands: [demand], sources: [], allocations: [], intents });
    expect(calculated.allocations).toEqual([]); expect(calculated.outstanding_demands[0].quantity).toBe('20');
  });

  it('subtracts received units and secured future coverage once, retaining the remaining additional-launch shortage', () => {
    const intents = reconcileReplenishmentProducerIdentities([root({ received: '10', released_attributed: '10', scrap: '2', status: 'EN_COURS' })], [source()]);
    const secured = { ...source(), quantity: '8' };
    const calculated = allocateOpenContractReplenishmentIntents({ demands: [demand], sources: [secured],
      allocations: [{ demand_id: demand.id, source_id: secured.id, kind: 'PRODUCTION', quantity: '8' }], intents });
    expect(calculated.allocations).toEqual([]); expect(calculated.outstanding_demands[0].quantity).toBe('12');
  });

  it('does not turn pending quality output into settled received quantity or launch replacements silently', () => {
    const intents = reconcileReplenishmentProducerIdentities([root({ received: '10', released_attributed: '5' })], []);
    expect(intents[0].status).toBe('REVIEW_REQUIRED');
    expect(() => allocateOpenContractReplenishmentIntents({ demands: [demand], sources: [], allocations: [], intents }))
      .toThrow('des pièces reçues ou une affectation à rapprocher');
  });

  it('retires only the grouped root share received, never the whole producer population', () => {
    const intents = reconcileReplenishmentProducerIdentities([group({ producer_received: '30', producer_attributed: '30', share_received: '10' })], []);
    const calculated = allocateOpenContractReplenishmentIntents({ demands: [demand], sources: [], allocations: [], intents });
    expect(calculated.allocations[0].quantity).toBe('10'); expect(calculated.outstanding_demands[0].quantity).toBe('10');
  });

  it('requires review for unassigned group output or losses without source attribution', () => {
    for (const row of [group({ producer_received: '10', producer_attributed: '5' }), group({ producer_scrap: '1' })])
      expect(reconcileReplenishmentProducerIdentities([row], [])[0].status).toBe('REVIEW_REQUIRED');
  });

  it('stops a completed producer with unexplained remaining quantity from permanently suppressing a replacement', () => {
    expect(reconcileReplenishmentProducerIdentities([root({ status: 'TERMINE' })], [])[0].status).toBe('REVIEW_REQUIRED');
  });

  it('retires a cancelled empty producer and refuses to reuse an OF tied to another firm delivery', () => {
    const intents = reconcileReplenishmentProducerIdentities([root({ status: 'ANNULE' }),
      root({ evidence_id: 'evidence-2', root_of_id: '102', order_line_id: 'firm-line' })], []);
    const calculated = allocateOpenContractReplenishmentIntents({ demands: [demand], sources: [], allocations: [], intents });
    expect(calculated.allocations).toEqual([]); expect(calculated.outstanding_demands[0].quantity).toBe('20');
  });

  it.each([
    root({ root_article_id: 'another' }), root({ root_unit: 'MM' }), root({ root_identity_valid: false }),
    group({ producer_identity_valid: false }), group({ share_quantity: '19' }), group({ received: '1' }),
    root({ received: '21', released_attributed: '21' }), root({ received: '1', released_attributed: '2' }), root({ quantity: '-1' }),
  ].map(row => ({ row })))('rejects mismatched producer identity or quantity ($row.evidence_id)', ({ row }) => {
    expect(() => reconcileReplenishmentProducerIdentities([row], [])).toThrow();
  });

  it('refuses two active grouping memberships for one immutable root', () => {
    expect(() => reconcileReplenishmentProducerIdentities([group(), group({ share_id: 'share-2', producer_id: '202' })], []))
      .toThrow('plusieurs regroupements actifs');
  });

  it('refuses a canonical coverage identity published with another owner or producer', () => {
    for (const incompatible of [{ ...source(), order_line_id: 'other' }, { ...source(), reference_id: '102' }])
      expect(() => reconcileReplenishmentProducerIdentities([root()], [incompatible])).toThrow('producteur attendu');
  });

  it('runs the persistent read on the caller transaction and rejects a truncated scope', async () => {
    const query = vi.fn().mockResolvedValueOnce({rows:[{installed:true}]}).mockResolvedValue({ rows: [root()] });
    const tx = { query } as unknown as Pick<PoolClient, 'query'>;
    expect(await readReplenishmentProducerIntents(tx, ['article-1'], [])).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('production_consolidation_allocations'), [['article-1']]);
    query.mockResolvedValueOnce({rows:[{installed:true}]}).mockResolvedValue({ rows: Array.from({ length: 501 }, (_, i) => root({ evidence_id: String(i) })) });
    await expect(readReplenishmentProducerIntents(tx, ['article-1'], [])).rejects.toMatchObject({ status: 422 });
  });
  it('reports a pending migration before attempting the producer query',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{installed:false}]}),tx={query} as unknown as Pick<PoolClient,'query'>;
    await expect(readReplenishmentProducerIntents(tx,['article-1'],[])).rejects.toMatchObject({status:409,code:'CONTRACT_REPLENISHMENT_NOT_INSTALLED'});
    expect(query).toHaveBeenCalledTimes(1);
  });
});
