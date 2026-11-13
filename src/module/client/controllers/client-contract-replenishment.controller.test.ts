import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
const ports = vi.hoisted(() => ({ prepare: vi.fn(), audit: vi.fn() }));
vi.mock('../services/client-contract-replenishment.service', () => ({ prepareClientReplenishment: ports.prepare, getClientReplenishmentPreparation: vi.fn() }));
vi.mock('./client-contract.controller', () => ({ clientContractAuditContext: ports.audit }));
import { postClientContractReplenishment } from './client-contract-replenishment.controller';
function fixture() {
  const req = { params: { id: '195', contractId: '11111111-1111-4111-8111-111111111111' },
    headers: { 'idempotency-key': '22222222-2222-4222-8222-222222222222' }, body: { action: 'PREPARE',
      expected_contract_version: 1, expected_plan_id: null, expected_snapshot_hash: 'a'.repeat(64), start_month: '2026-10', months: 12 } };
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
  const next = vi.fn(), execute = () => postClientContractReplenishment(req as unknown as Request, res as unknown as Response, next as NextFunction);
  return { req, res, next, execute };
}
beforeEach(() => { vi.resetAllMocks(); ports.audit.mockReturnValue({ user_id: 7 });
  ports.prepare.mockResolvedValue({ replayed: false, result: { event_id: 'event-a', unchanged: false, plan: { id: 'plan-a' } } }); });
describe('preparation confirmation discriminator', () => {
  it('returns the canonical fresh/replay discriminator in JSON as well as its transport header', async () => {
    const f = fixture(); await f.execute();
    expect(f.res.json).toHaveBeenCalledWith({ event_id: 'event-a', unchanged: false, plan: { id: 'plan-a' }, replayed: false });
    expect(f.res.status).toHaveBeenCalledWith(201);
    expect(f.res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'false');
  });
  it('qualifies an acknowledgement replay without claiming a new successful preparation', async () => {
    const f = fixture(); ports.prepare.mockResolvedValue({ replayed: true, result: { event_id: 'event-a', unchanged: false, plan: { id: 'plan-a' } } });
    await f.execute(); expect(f.res.json).toHaveBeenCalledWith(expect.objectContaining({ event_id: 'event-a', replayed: true }));
    expect(f.res.status).toHaveBeenCalledWith(200); expect(f.res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
  });
  it('does not fabricate a success discriminator when the preparation failed', async () => {
    const f = fixture(), failure = Error('Coverage changed'); ports.prepare.mockRejectedValue(failure);
    await f.execute(); expect(f.next).toHaveBeenCalledExactlyOnceWith(failure); expect(f.res.json).not.toHaveBeenCalled();
  });
  it('does not invent a retry key when the caller omitted it', async () => {
    const f = fixture(); f.req.headers['idempotency-key'] = ''; await f.execute();
    expect(ports.prepare).not.toHaveBeenCalled(); expect(f.next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ZodError' }));
  });
});
