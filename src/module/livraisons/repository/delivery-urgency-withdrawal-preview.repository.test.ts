import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), read: vi.fn() }));
vi.mock('../../../config/database', () => ({ default: { connect: async () => ({ query: mocks.query, release: mocks.release }) } }));
vi.mock('../../planning/repository/urgency-approval.repository', () => ({ readUrgencyApprovalTx: mocks.read }));
import { repoPreviewUrgencyWithdrawal } from './delivery-urgency-withdrawal-preview.repository';

let current: ReturnType<typeof control>, approval: { id: string; request_version: number; evidence: { planning_basis?: string } } | null;
function control() {
  return { request: { version: 2, approved_id: 'approval', status: 'APPROVED', quantity: '2.5' }, basis: 'slots-and-definition',
    response: { issues: [] as { code: string; message: string }[], preview_hash: 'live-stock-and-planning', recoveries: [], checked_at: '2026-10-12T10:00:00Z' },
    donorPlan: { response: { donors: [{ reservation_id: 'donor', proposed_quantity: '2.5' }] } } };
}
beforeEach(() => {
  vi.clearAllMocks(); current = control(); approval = { id: 'approval', request_version: 1, evidence: { planning_basis: current.basis } };
  mocks.read.mockImplementation(async () => current);
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM public.delivery_urgency_approvals') && approval ? [approval] : [] }));
});
describe('withdrawal preview', () => {
  it('permits only the current approved production definition and slots', async () => {
    expect(await repoPreviewUrgencyWithdrawal('request')).toMatchObject({ can_withdraw: true, request_version: 2, quantity: '2.5', approval_id: 'approval' });
    expect(mocks.query.mock.calls[0][0]).toContain('READ ONLY');
    expect(mocks.query.mock.calls.at(-1)![0]).toBe('COMMIT');
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'old-version', 'pending'] as const)('refuses an unavailable planner decision: %s', async state => {
    if (state === 'missing') approval = null;
    if (state === 'old-version') approval!.request_version = 0;
    if (state === 'pending') current.request.status = 'WAITING_PLANNER';
    expect(await repoPreviewUrgencyWithdrawal('request')).toMatchObject({ can_withdraw: false, issues: [{ code: 'URGENCY_APPROVAL_REQUIRED' }] });
  });
  it('requires renewed approval when the scheduled recovery changes', async () => {
    current.basis = 'another-machine-or-slot';
    expect(await repoPreviewUrgencyWithdrawal('request')).toMatchObject({ can_withdraw: false, issues: [{ code: 'URGENCY_APPROVAL_OBSOLETE' }] });
  });
  it('rechecks stock, quality and feasibility even if the original approval is unchanged', async () => {
    const first = await repoPreviewUrgencyWithdrawal('request');
    current.response.issues.push({ code: 'URGENCY_DONOR_CHANGED', message: 'La quantité a été préparée sur un BL.' });
    const next = await repoPreviewUrgencyWithdrawal('request');
    expect(next.can_withdraw).toBe(false); expect(next.preview_hash).not.toBe(first.preview_hash);
  });
  it('rolls back and releases the read transaction on failure', async () => {
    mocks.read.mockRejectedValueOnce(new Error('read failed'));
    await expect(repoPreviewUrgencyWithdrawal('request')).rejects.toThrow('read failed');
    expect(mocks.query.mock.calls.at(-1)![0]).toBe('ROLLBACK'); expect(mocks.release).toHaveBeenCalledOnce();
  });
});
