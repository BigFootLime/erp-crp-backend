import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/database', () => ({ default: { connect: vi.fn() } }));
vi.mock('./planning-central.repository', () => ({ readCentralSnapshot: vi.fn() }));
vi.mock('./planning-replenishment-targets.repository', () => ({
  earliestReplenishmentTarget: vi.fn((commercialDue: string | null) => commercialDue),
  readReplenishmentPlanningTargets: vi.fn().mockResolvedValue(new Map()),
}));

import pool from '../../../config/database';
import { readCentralSnapshot } from './planning-central.repository';
import { readMasterPlanSource } from './planning-master-plan.repository';

const period = { label: '2026-10-19', start: '2026-10-18T22:00:00.000Z', end: '2026-10-25T22:00:00.000Z' };
const emptyOrderRows = { rows: [] };

function connection(checkpointsInstalled: boolean) {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('generate_series')) return { rows: [period] };
    if (sql.includes("to_regclass('public.data_cutover_wip_operation_checkpoints')")) return { rows: [{ installed: checkpointsInstalled }] };
    if (sql.includes('FROM public.ordres_fabrication')) return emptyOrderRows;
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  });
  return { query, release: vi.fn() };
}

describe('master plan source cutover checkpoint fallback', () => {
  afterEach(() => vi.clearAllMocks());

  it('keeps the ordinary master plan query when checkpoint storage is not installed', async () => {
    const tx = connection(false);
    vi.mocked(pool.connect).mockResolvedValue(tx as never);
    vi.mocked(readCentralSnapshot).mockResolvedValue({ nextCursor: null } as never);

    await readMasterPlanSource({ start: '2026-10-19', weeks: 1, revision: undefined });

    const orderQuery = tx.query.mock.calls.map(([sql]) => String(sql)).find(sql => sql.includes('FROM public.ordres_fabrication'))!;
    expect(orderQuery).not.toContain('data_cutover_wip_operation_checkpoints');
    expect(tx.query.mock.calls.some(([sql]) => /\b(?:INSERT|UPDATE|DELETE)\b/.test(String(sql)))).toBe(false);
  });

  it('removes completed cutover phases from a resumed OF before central recalculation', async () => {
    const tx = connection(true);
    vi.mocked(pool.connect).mockResolvedValue(tx as never);
    vi.mocked(readCentralSnapshot).mockResolvedValue({ nextCursor: null } as never);

    await readMasterPlanSource({ start: '2026-10-19', weeks: 1, revision: undefined });

    const orderQuery = tx.query.mock.calls.map(([sql]) => String(sql)).find(sql => sql.includes('FROM public.ordres_fabrication'))!;
    expect(orderQuery).toContain("checkpoint.checkpoint_status='COMPLETED'");
    expect(orderQuery).toContain('resume.of_id=o.id');
    expect(readCentralSnapshot).toHaveBeenCalledWith(expect.objectContaining({ includeTaskIds: [] }), tx, false);
  });
});
