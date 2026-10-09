import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveCumpStockCost, resolveCumpStockCosts, type CumpStockCostRow } from './cump-stock-cost';
import { CUMP_FORMULA_VERSION, type CumpScope } from '../../stock/domain/cump-valuation';

// Pure valuation fixtures; database acceptance is tracked separately.
const ARTICLE = '00000000-0000-0000-0000-000000000001';
const MOVEMENT = '00000000-0000-0000-0000-000000000002';
const LINE = '00000000-0000-0000-0000-000000000003';
const ENTRY = '00000000-0000-0000-0000-000000000004';
const scope: CumpScope = { articleId: ARTICLE, owner: 'COMPANY', unit: 'u', currency: 'EUR' };
function row(patch: Partial<CumpStockCostRow> = {}): CumpStockCostRow {
  return {
    cost: { key: `stock-consumption:${LINE}`, category: 'MATERIAL', amount_ht: '999', quantity: '10',
      source_type: 'STOCK_POSTED_CONSUMPTION_COST', source_ref: MOVEMENT, observed_at: '2026-10-08T08:00:00Z',
      source_reliability: 'DECLARED', currency: 'EUR', source_document_type: 'STOCK_MOVEMENT_LINE', source_document_ref: LINE },
    mode: 'ACTIVE', initialized: true, reporting_currency: 'EUR', formula_version: CUMP_FORMULA_VERSION,
    last_sequence: '10', article_pending: false, article_blocked: false,
    journal: { movement_id: MOVEMENT, article_id: ARTICLE, sequence: '10', source_sha256: 'a'.repeat(64), source_valid: true,
      acquisition_snapshot: null, acquisition_sha256: null, acquisition_valid: null,
      source_snapshot: { schema_version: 1, movement_id: MOVEMENT, article_id: ARTICLE, movement_type: 'OUT',
        quantity: '10', stock_unit: 'u', stock_batch_id: null, batch_owner_client_id: null, reversal_of_id: null,
        document_type: 'OF', document_id: '91', source_document_type: 'OF', source_document_id: '91',
        lines: [{ line_id: LINE, article_id: ARTICLE, quantity: '10', unit: 'u', owner_client_id: null }] } },
    entries: [{ entry_id: ENTRY, article_id: ARTICLE, owner_key: 'COMPANY', stock_unit: 'u', currency: 'EUR',
      kind: 'ISSUE', sequence: '10', formula_version: CUMP_FORMULA_VERSION, quantity_delta: '-10',
      movement_value: '50.000000000000', reliability: 'VERIFIED', source_valid: true,
      source_snapshot: { before_state: { scope, quantity: '20', value: '100', reliability: 'VERIFIED', sourceRef: 'prior-entry' },
        after_state: { scope, quantity: '10', value: '50', reliability: 'VERIFIED', sourceRef: `stock-valuation-entry:${ENTRY}` } } }],
    returns: [], ...patch,
  };
}
const resolve = (patch: Partial<CumpStockCostRow> = {}) => resolveCumpStockCost(row(patch), '91');

test('uses exact historical issue amount instead of the applied price on the line', () => {
  const cost = resolve();
  assert.equal(cost.amount_ht, '50');
  assert.equal(cost.source_reliability, 'VERIFIED');
  assert.equal(cost.source_type, 'STOCK_CUMP_NET_ISSUE_COST');
  assert.equal(cost.key, `stock-consumption:${LINE}`);
});

test('net returned quantity and value reduce cost, including net cancellation effects', () => {
  const returned = { original_entry_id: ENTRY, owner_key: 'COMPANY' as const, stock_unit: 'u', currency: 'EUR',
    quantity: '2', value: '10', source_valid: true };
  assert.equal(resolve({ returns: [returned] }).amount_ht, '40');
  assert.equal(resolve({ returns: [returned] }).quantity, '8');
  assert.equal(resolve({ returns: [{ ...returned, quantity: '0', value: '0' }] }).amount_ht, '50');
  assert.equal(resolve({ returns: [{ ...returned, quantity: '10', value: '50' }] }).amount_ht, '0');
  for (const invalid of [{ ...returned, quantity: '11' }, { ...returned, value: '51' },
    { ...returned, quantity: '0' }, { ...returned, source_valid: false }, { ...returned, value: null }])
    assert.equal(resolve({ returns: [invalid] }).amount_ht, null);
});

test('client ownership is frozen on the physical posting, not inferred from a current lot price', () => {
  const original = row();
  const root = original.journal!.source_snapshot as Record<string, unknown>;
  (root.lines as Record<string, unknown>[])[0].owner_client_id = 'Cli-001';
  const cost = resolveCumpStockCost({ ...original, mode: 'PREPARED', entries: [], cost: { ...original.cost, currency: null } }, '91');
  assert.equal(cost.availability, 'NOT_APPLICABLE');
  assert.equal(cost.amount_ht, null);
  assert.equal(cost.source_type, 'CLIENT_OWNED_STOCK_EXCLUDED');
});

test('inactive CUMP retains clearly declared legacy cost without upgrading its reliability', () => {
  const cost = resolve({ mode: 'PREPARED', initialized: false, entries: [] });
  assert.equal(cost.amount_ht, '999');
  assert.equal(cost.source_reliability, 'DECLARED');
  assert.match(cost.definition!, /CUMP non vérifié/);
});

test('active projection refuses missing, late, mismatched or unsupported financial evidence', () => {
  const original = row();
  for (const patch of [
    { journal: null }, { initialized: false }, { formula_version: 'other' },
    { article_pending: true }, { article_blocked: true }, { entries: [] },
    { entries: [{ ...original.entries[0], source_valid: false }] },
    { entries: [{ ...original.entries[0], movement_value: '60' }] },
    { cost: { ...original.cost, quantity: '9' } }, { cost: { ...original.cost, currency: 'USD' } },
  ] as Partial<CumpStockCostRow>[]) {
    const cost = resolve(patch);
    assert.equal(cost.amount_ht, null);
    assert.equal(cost.source_reliability, 'UNKNOWN');
  }
  assert.equal(resolveCumpStockCost(original, '92').amount_ht, null);
});

test('multi-line roots and dense source windows never produce an invented allocation', () => {
  const original = row();
  const lines = (original.journal!.source_snapshot as Record<string, unknown>).lines as Record<string, unknown>[];
  lines[0].quantity = '5'; lines.push({ ...lines[0], line_id: '00000000-0000-0000-0000-000000000005' });
  assert.equal(resolveCumpStockCost(original, '91').amount_ht, null);
  const costs = resolveCumpStockCosts(Array.from({ length: 10001 }, () => row()), '91');
  assert.equal(costs.length, 1);
  assert.equal(costs[0].source_type, 'STOCK_CUMP_WINDOW_TOO_DENSE');
  assert.equal(costs[0].amount_ht, null);
});
