import { describe, expect, it } from 'vitest';
import { projectContractReplenishmentLots } from './client-contract-replenishment';
import { prepareContractReplenishmentSnapshot } from './client-contract-replenishment-preparation';
import { clientReplenishmentPreparationSchema } from '../validators/client-contract-replenishment.validators';
import type { ContractCoverageResult } from '../types/client-contract-coverage.types';

const article = { article_id: '00000000-0000-4000-8000-000000000001', root_article_id: '00000000-0000-4000-8000-000000000002',
  code: 'PF-001', designation: 'Axe', piece_technique_id: '00000000-0000-4000-8000-000000000003',
  piece_technique_version_id: '00000000-0000-4000-8000-000000000004', indice: 'A',
  unit_id: '00000000-0000-4000-8000-000000000005', unit: 'U' };
function report(): ContractCoverageResult {
  return { contract_id: '00000000-0000-4000-8000-000000000006', contract_version: 1, generated_at: '2026-10-10T08:00:00Z',
    planning_revision: null, start_month: '2026-10', months: 3, readonly: true, snapshot_hash: 'a'.repeat(64),
    lines: [{ contract_line_id: '00000000-0000-4000-8000-000000000007', replenishment_qty: '20', article, months: [],
      replenishment_projection: projectContractReplenishmentLots({ replenishmentQty: '20', today: '2026-10-10', months: [
        { month: '2026-10', target_date: '2026-09-30', missing_quantity: '17' },
        { month: '2026-11', target_date: '2026-10-31', missing_quantity: '28' },
        { month: '2026-12', target_date: '2026-11-30', missing_quantity: '5' },
      ] }) }], demands: [], sources: [], allocations: [], issues: [] };
}
describe('immutable contract replenishment preparation', () => {
  it('keeps two monthly proposals containing three fixed lots, original dates and selected technical identity', () => {
    const prepared = prepareContractReplenishmentSnapshot(report(), '2026-10-10');
    expect(prepared.proposals.map(row => [row.month, row.lot_count, row.proposed_quantity, row.target_date, row.target_overdue]))
      .toEqual([['2026-10', '1', '20', '2026-09-30', true], ['2026-11', '2', '40', '2026-10-31', false]]);
    expect(prepared.proposals[1].surplus_quantity).toBe('15');
    expect(prepared.report.lines[0].replenishment_projection[2].surplus_quantity).toBe('10');
    expect(prepared.proposals.every(row => row.article === article)).toBe(true);
  });
  it('ignores read timestamps while detecting changed stock, technical definition and the Paris calendar day', () => {
    const baseline = prepareContractReplenishmentSnapshot(report(), '2026-10-10').fingerprint;
    const later = report(); later.generated_at = '2026-10-10T09:00:00Z';
    expect(prepareContractReplenishmentSnapshot(later, '2026-10-10').fingerprint).toBe(baseline);
    later.snapshot_hash = 'b'.repeat(64);
    expect(prepareContractReplenishmentSnapshot(later, '2026-10-10').fingerprint).not.toBe(baseline);
    const changed = report(); changed.lines[0].article = { ...article, indice: 'B' };
    expect(prepareContractReplenishmentSnapshot(changed, '2026-10-10').fingerprint).not.toBe(baseline);
    expect(prepareContractReplenishmentSnapshot(report(), '2026-10-11').fingerprint).not.toBe(baseline);
  });
  it('refuses an overflowing lot projection instead of truncating it to database precision', () => {
    const source = report(); source.lines[0].replenishment_projection[0].proposed_quantity = '1000000000.001';
    expect(() => prepareContractReplenishmentSnapshot(source, '2026-10-10')).toThrow('La quantité proposée dépasse');
    source.lines[0].replenishment_projection[0].proposed_quantity = '0.0009';
    expect(() => prepareContractReplenishmentSnapshot(source, '2026-10-10')).toThrow('trois décimales');
  });
  it('accepts concurrency proofs, rejects browser-edited quantities, wrong dates and excessive horizons', () => {
    const command = { action: 'PREPARE', expected_contract_version: 1, expected_plan_id: null,
      expected_snapshot_hash: 'a'.repeat(64), start_month: '2026-10', months: 3 };
    expect(clientReplenishmentPreparationSchema.safeParse(command).success).toBe(true);
    for (const invalid of [{ ...command, proposed_quantity: 40 }, { ...command, expected_snapshot_hash: '' },
      { ...command, start_month: '2026-13' }, { ...command, months: 37 }, { ...command, action: 'GENERATE' }])
      expect(clientReplenishmentPreparationSchema.safeParse(invalid).success).toBe(false);
  });
});
