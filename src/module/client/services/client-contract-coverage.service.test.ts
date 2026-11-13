import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), release: vi.fn(),
  client: vi.fn(), contract: vi.fn(), demands: vi.fn(), stock: vi.fn(), production: vi.fn() }));
vi.mock('../../../config/database', () => ({ default: { connect: mocks.connect } }));
vi.mock('../repository/client-crm.repository', () => ({ readCrmClient: mocks.client }));
vi.mock('../repository/client-contract.repository', () => ({ readClientContract: mocks.contract }));
vi.mock('../repository/client-contract-coverage.repository', () => ({ CONTRACT_COVERAGE_PERIODS_SQL: 'periods', readContractCoverageDemands: mocks.demands }));
vi.mock('../repository/client-contract-coverage-stock.repository', () => ({ readContractCoverageStock: mocks.stock }));
vi.mock('../repository/client-contract-coverage-production.repository', () => ({ readContractCoverageProduction: mocks.production }));

import { getClientContractCoverage, readClientContractCoverageTx } from './client-contract-coverage.service';

const article = { article_id: 'article-a', root_article_id: 'root-a', unit_id: 'unit-a', unit: 'u',
  piece_technique_id: 'pt-a', piece_technique_version_id: 'version-a', code: 'ARTICLE-A', designation: 'Pièce A', indice: 'A' };
const demand = (id: string, contract: string) => ({ id, kind: 'FORECAST', article_id: article.article_id, unit: 'u',
  contract_id: contract, contract_line_id: contract === 'contract-a' ? 'line-a' : 'line-b', order_line_id: null, allocation_id: null,
  quantity: '10', due_date: '2026-10-31', month: '2026-10', target_date: '2026-09-30' });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.query.mockImplementation(async (sql: string) => sql === 'periods'
    ? { rows: [{ month: '2026-10', target_date: '2026-09-30', end_date: '2026-10-31' }] }
    : sql.includes('SELECT now()') ? { rows: [{ now: '2026-10-10T08:00:00Z', today: '2026-10-10', month: '2026-10' }] } : { rows: [] });
  mocks.client.mockResolvedValue({ id: 'client-a' });
  mocks.contract.mockResolvedValue({ id: 'contract-a', status: 'ACTIVE', version: 1,
    lines: [{ id: 'line-a', replenishment_qty: '20', proposed_article: article }] });
  mocks.demands.mockResolvedValue({ demands: [demand('a', 'contract-a'), demand('b', 'contract-b')], firm: [] });
  mocks.stock.mockResolvedValue({ sources: [{ id: 'stock-a', kind: 'FREE', article_id: article.article_id, unit: 'U',
    quantity: '12', available_date: null, order_line_id: null, allocation_id: null, reference_id: 'lot-a', label: 'Lot A' }], issues: [] });
  mocks.production.mockResolvedValue({ sources: [], issues: [], revision: null });
});

describe('coverage transaction ownership and shared allocation', () => {
  it('keeps the public read transaction read-only and does not expose other contract allocations', async () => {
    const report = await getClientContractCoverage('client-a', 'contract-a', { months: 1 });
    expect(mocks.query.mock.calls.map(call => call[0]).filter(sql => sql.startsWith('BEGIN') || sql === 'COMMIT')).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT']);
    expect(mocks.connect).toHaveBeenCalledTimes(1); expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(report.demands.map(row => row.id)).toEqual(['a']);
    expect(report.allocations).toEqual([{ demand_id: 'a', source_id: 'stock-a', kind: 'FREE', quantity: '10' }]);
    expect(report.lines[0].months[0].missing_quantity).toBe('0');
    expect(report.lines[0].replenishment_projection[0].lot_count).toBe('0');
    expect(report).not.toHaveProperty('allAllocations');
  });

  it('reuses the supplied connection, retaining the single shared stock budget for proposal planning', async () => {
    const supplied = { query: mocks.query };
    const snapshot = await readClientContractCoverageTx(supplied, 'client-a', 'contract-a', { months: 1 });
    expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(call => /^(BEGIN|COMMIT|ROLLBACK)/.test(call[0]))).toBe(false);
    expect(snapshot.allAllocations.map(row => row.quantity)).toEqual(['10', '2']);
    expect(snapshot.allDemands.map(row => row.id)).toEqual(['a', 'b']);
    expect(mocks.stock).toHaveBeenCalledWith(supplied, ['article-a']);
    expect(mocks.production.mock.calls[0][0]).toBe(supplied);
    expect(snapshot.report.sources.map(row => row.id)).toEqual(['stock-a']);
  });

  it('rolls back and releases the public connection when the contract cannot be calculated', async () => {
    mocks.contract.mockResolvedValue({ status: 'CLOSED', lines: [] });
    await expect(getClientContractCoverage('client-a', 'contract-a', { months: 1 })).rejects.toMatchObject({ code: 'CONTRACT_COVERAGE_CONTRACT_INACTIVE' });
    expect(mocks.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.query).not.toHaveBeenCalledWith('COMMIT'); expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.stock).not.toHaveBeenCalled();
  });

  it('leaves error recovery to the owner of a supplied transaction', async () => {
    mocks.client.mockResolvedValue(null);
    await expect(readClientContractCoverageTx({ query: mocks.query }, 'client-a', 'contract-a', { months: 1 }))
      .rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
    expect(mocks.query).not.toHaveBeenCalledWith('ROLLBACK'); expect(mocks.release).not.toHaveBeenCalled();
  });
});
