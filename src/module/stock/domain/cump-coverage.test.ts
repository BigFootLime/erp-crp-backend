import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCumpArticleCoverage, type CumpCoverageSnapshot, type CumpProjectedPosition } from './cump-coverage';
import { CUMP_FORMULA_VERSION } from './cump-valuation';
import type { CumpOpeningRow } from './cump-opening';

// Prepared for the final common acceptance run; not executed during deployment.
const ARTICLE = '00000000-0000-0000-0000-000000000001';
const LEVEL = '00000000-0000-0000-0000-000000000002';
const BATCH = '00000000-0000-0000-0000-000000000003';
function physical(kind: 'LEVEL' | 'BATCH', total: string, owner: string | null = null): CumpOpeningRow {
  return {
    id: kind === 'LEVEL' ? LEVEL : BATCH, stock_level_id: LEVEL,
    stock_batch_id: kind === 'LEVEL' ? null : BATCH, article_id: ARTICLE, source_valid: true,
    source_snapshot: { schema_version: 1, kind, article_id: ARTICLE, stock_level_id: LEVEL,
      stock_batch_id: kind === 'LEVEL' ? null : BATCH, stock_unit: 'u',
      quantity_total: total, quantity_depreciated: '0', quantity_reserved: '4', owner_client_id: owner },
  };
}
function projection(owner: CumpProjectedPosition['owner_key'] = 'COMPANY', quantity = '10', value: string | null = '50'): CumpProjectedPosition {
  return { article_id: ARTICLE, owner_key: owner, stock_unit: 'u', currency: 'EUR', quantity, value,
    reliability: 'VERIFIED', source_ref: 'stock-valuation:entry', latest_sequence: '10',
    latest_entry_id: '00000000-0000-0000-0000-000000000004', source_valid: true };
}
function snapshot(patch: Partial<CumpCoverageSnapshot> = {}): CumpCoverageSnapshot {
  return { article_id: ARTICLE, code: 'MP-1', designation: 'Barre', observed_at: '2026-10-08T08:00:00Z',
    mode: 'ACTIVE', initialized: true, reporting_currency: 'EUR', formula_version: CUMP_FORMULA_VERSION,
    last_sequence: '10', pending_movements: '0', blocked: false, capture_missing: false,
    physical: [physical('LEVEL', '10')], projected: [projection()], ...patch };
}
const result = (patch: Partial<CumpCoverageSnapshot> = {}) => resolveCumpArticleCoverage(snapshot(patch));

test('reservations do not reduce usable value; company batches are not added twice', () => {
  const p = result({ physical: [physical('LEVEL', '10'), physical('BATCH', '4')] }).positions[0];
  assert.equal(p.physical_quantity, '10');
  assert.equal(p.status, 'AVAILABLE');
  assert.equal(p.value, '50');
  assert.equal(p.unit_cost, '5');
});

test('client lots remain separate, preserve client code case, and expose no company value', () => {
  const positions = result({ physical: [physical('LEVEL', '10'), physical('BATCH', '4', 'Cli-001')],
    projected: [projection('COMPANY', '6', '30'), projection('CLIENT:Cli-001', '4', null)] }).positions;
  const company = positions.find(p => p.scope.owner === 'COMPANY')!;
  const client = positions.find(p => p.scope.owner === 'CLIENT:Cli-001')!;
  assert.equal(company.physical_quantity, '6');
  assert.equal(company.value, '30');
  assert.equal(client.status, 'CLIENT_OWNED');
  assert.equal(client.value, null);
  assert.equal(client.unit_cost, null);
});

test('quantity disagreement suppresses an otherwise verified stored value', () => {
  const p = result({ projected: [projection('COMPANY', '9', '45')] }).positions[0];
  assert.equal(p.status, 'MISMATCH');
  assert.equal(p.value, null);
  assert.equal(p.unit_cost, null);
});

test('inactivity, lag, missing capture and broken entry proof prevent financial availability', () => {
  for (const [patch, status] of [
    [{ mode: 'PREPARED', initialized: false }, 'PREPARED'],
    [{ pending_movements: '1' }, 'PENDING'],
    [{ capture_missing: true }, 'UNKNOWN'],
    [{ blocked: true }, 'UNKNOWN'],
    [{ projected: [{ ...projection(), source_valid: false }] }, 'UNKNOWN'],
    [{ projected: [{ ...projection(), latest_sequence: '11' }] }, 'UNKNOWN'],
    [{ projected: [projection('COMPANY', '10', null)] }, 'UNKNOWN'],
  ] as [Partial<CumpCoverageSnapshot>, string][]) {
    const p = result(patch).positions[0];
    assert.equal(p.status, status);
    assert.equal(p.value, null);
    assert.equal(p.unit_cost, null);
  }
});

test('invalid physical evidence does not expose a partially accumulated quantity', () => {
  const p = result({ physical: [physical('LEVEL', '10'), { ...physical('BATCH', '4'), source_valid: false }] }).positions[0];
  assert.equal(p.physical_quantity, null);
  assert.equal(p.status, 'UNKNOWN');
  assert.equal(p.value, null);
});

test('depreciation is deducted; verified empty stock has zero value and no unit cost', () => {
  const row = physical('LEVEL', '10');
  (row.source_snapshot as Record<string, unknown>).quantity_depreciated = '2';
  assert.equal(result({ physical: [row], projected: [projection('COMPANY', '8', '40')] }).positions[0].physical_quantity, '8');
  const p = result({ physical: [physical('LEVEL', '0')], projected: [projection('COMPANY', '0', '0')] }).positions[0];
  assert.equal(p.status, 'AVAILABLE');
  assert.equal(p.value, '0');
  assert.equal(p.unit_cost, null);
  assert.equal(result({ physical: [physical('LEVEL', '0')], projected: [projection('COMPANY', '0', '1')] }).positions[0].value, null);
});

test('unsupported financial precision and excess query window fail closed', () => {
  assert.equal(result({ projected: [projection('COMPANY', '10', '1.0000000000001')] }).positions[0].status, 'UNKNOWN');
  const dense = result({ physical: Array.from({ length: 10001 }, () => physical('LEVEL', '10')) });
  assert.deepEqual(dense.positions, []);
  assert.deepEqual(dense.issues, ['STOCK_COVERAGE_WINDOW_TOO_DENSE']);
});
