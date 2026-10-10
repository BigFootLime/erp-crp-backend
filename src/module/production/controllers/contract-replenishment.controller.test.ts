import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const ports = vi.hoisted(() => ({ generate: vi.fn(), audit: vi.fn() }));
vi.mock('../../client/services/client-contract-replenishment-launch.service', () => ({ generateClientContractReplenishment: ports.generate }));
vi.mock('../../client/controllers/client-contract.controller', () => ({ clientContractAuditContext: ports.audit }));
import { generateContractReplenishment } from './contract-replenishment.controller';

const contract = 'ABCDEFAB-3333-4333-8333-333333333333', plan = 'ABCDEFAB-4444-4444-8444-444444444444';
const proposal = 'ABCDEFAB-5555-4555-8555-555555555555', key = 'abcdefab-6666-4666-8666-666666666666';
function fixture() {
  const req = { params: { clientId: '195', contractId: contract }, headers: { 'idempotency-key': key },
    body: { action: 'GENERATE', plan_id: plan, proposal_ids: [proposal] }, user: { id: 7, role: 'Production' } };
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
  const next = vi.fn();
  const execute = () => generateContractReplenishment(req as unknown as Request, res as unknown as Response, next as NextFunction);
  return { req, res, next, execute };
}
beforeEach(() => {
  vi.resetAllMocks(); ports.audit.mockReturnValue({ user_id: 7, page_key: 'clients.contracts' });
  ports.generate.mockResolvedValue({ replayed: false, result: { launch_id: 'launch-1', roots: [] } });
});

describe('production replenishment command boundary', () => {
  it('normalizes technical identities and passes the authenticated role, original key and production audit context', async () => {
    const f = fixture(); await f.execute();
    expect(ports.generate).toHaveBeenCalledExactlyOnceWith('195', contract.toLowerCase(),
      { action: 'GENERATE', plan_id: plan.toLowerCase(), proposal_ids: [proposal.toLowerCase()] }, key,
      { user_id: 7, page_key: 'production.replenishment' }, 'Production');
    expect(f.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(f.res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'false');
    expect(f.res.status).toHaveBeenCalledWith(201); expect(f.next).not.toHaveBeenCalled();
  });

  it('returns the original acknowledgement on replay without claiming another creation', async () => {
    const f = fixture(); ports.generate.mockResolvedValue({ replayed: true, result: { launch_id: 'saved-1' } });
    await f.execute(); expect(f.res.status).toHaveBeenCalledWith(200);
    expect(f.res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
    expect(f.res.json).toHaveBeenCalledWith({ launch_id: 'saved-1' });
  });

  it('rejects browser-supplied quantities instead of overriding the server proposal', async () => {
    const f = fixture(); Object.assign(f.req.body, { quantity: 999 }); await f.execute();
    expect(f.next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ZodError' }));
    expect(ports.generate).not.toHaveBeenCalled(); expect(f.res.json).not.toHaveBeenCalled();
  });

  it('rejects duplicate proposals after case normalization', async () => {
    const f = fixture(); f.req.body.proposal_ids.push(proposal.toLowerCase()); await f.execute();
    expect(f.next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ZodError' }));
    expect(ports.generate).not.toHaveBeenCalled();
  });

  it('requires the caller idempotency key rather than generating a fresh attempt automatically', async () => {
    const f = fixture(); f.req.headers['idempotency-key'] = ''; await f.execute();
    expect(f.next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ZodError' }));
    expect(ports.generate).not.toHaveBeenCalled();
  });

  it('preserves actionable coverage conflicts from the service without a success body', async () => {
    const f = fixture(), failure = Object.assign(Error('Recalculez'), { status: 409, code: 'CONTRACT_REPLENISHMENT_COVERAGE_CHANGED' });
    ports.generate.mockRejectedValue(failure); await f.execute();
    expect(f.next).toHaveBeenCalledExactlyOnceWith(failure); expect(f.res.status).not.toHaveBeenCalled();
  });
});
