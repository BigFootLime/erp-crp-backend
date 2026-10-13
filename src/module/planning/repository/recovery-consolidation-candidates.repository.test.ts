import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../config/database', () => ({ default: {} }));
import { readRecoveryGroupingCandidatesTx } from './recovery-consolidation-candidates.repository';
const context = { enabled: true, status: 'WAITING_PLANNER', of_status: 'BROUILLON', covered: false };
const row = (producer_of_id: number) => ({ consolidation_id: `group-${producer_of_id}`, producer_of_id,
  producer_number: `OF-${producer_of_id}`, quantity: 100, status: 'EN_COURS', cutting_finished: false, operation_finished: false, cutting_missing: false });
function database(state = context, rows = [row(10)]) {
  return { query: vi.fn().mockResolvedValueOnce({ rows: [state] }).mockResolvedValueOnce({ rows }) };
}
describe('recovery grouping discovery', () => {
  it('keeps pages bounded and flags closed cutting gates before a user selects them', async () => {
    const db = database(context, [{ ...row(10), cutting_finished: true }, row(11), row(12)]);
    const result = await readRecoveryGroupingCandidatesTx(db, 'recovery', { q: 'OF_%', limit: 2, cursor: 9 });
    expect(result.items).toHaveLength(2); expect(result.next_cursor).toBe(11);
    expect(result.items[0].blocker).toContain('Découpe terminée'); expect(result.items[1].blocker).toBeNull();
    expect(db.query.mock.calls[1][1]).toEqual(['recovery', 9, '%OF\\_\\%%', 3]);
  });
  it.each([{ ...context, covered: true }, { ...context, of_status: 'EN_COURS' }])('does not offer producers for an already engaged recovery', async state => {
    const db = database(state); expect(await readRecoveryGroupingCandidatesTx(db, 'recovery', { q: '', limit: 5 })).toMatchObject({ available: false, items: [] });
    expect(db.query).toHaveBeenCalledOnce();
  });
  it.each([[{ ...context, status: 'CANCELLED' }, 'RECOVERY_CLOSED'], [{ ...context, enabled: false }, 'CONSOLIDATION_DISABLED']] as const)('rejects unavailable recovery context', async (state, code) => {
    await expect(readRecoveryGroupingCandidatesTx(database(state), 'recovery', { q: '', limit: 5 })).rejects.toMatchObject({ code });
  });
  it('reports absent data distinctly from an empty compatible page', async () => {
    await expect(readRecoveryGroupingCandidatesTx({ query: vi.fn().mockResolvedValue({ rows: [] }) }, 'missing', { q: '', limit: 5 })).rejects.toMatchObject({ code: 'RECOVERY_NOT_FOUND' });
    expect(await readRecoveryGroupingCandidatesTx(database(context, []), 'recovery', { q: '', limit: 5 })).toEqual({ available: true, reason: null, items: [], next_cursor: null });
  });
});
