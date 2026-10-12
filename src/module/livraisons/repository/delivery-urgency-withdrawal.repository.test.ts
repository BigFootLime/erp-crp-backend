import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), read: vi.fn(), quality: vi.fn(), topology: vi.fn(),
  transfer: vi.fn(), refresh: vi.fn(), audit: vi.fn(), ofAudit: vi.fn(), enqueue: vi.fn() }));
vi.mock('../../../config/database', () => ({ default: { connect: async () => ({ query: mocks.query, release: mocks.release }) } }));
vi.mock('./delivery-urgency-withdrawal-preview.repository', () => ({ readUrgencyWithdrawalTx: mocks.read }));
vi.mock('./urgency-withdrawal-stock.repository', () => ({ transferUrgencyReservationTx: mocks.transfer, refreshUrgencyDonorCoverageTx: mocks.refresh }));
vi.mock('../../qualite/repository/quality-operational-gate.repository', () => ({ assertOperationalLotQualityEligibility: mocks.quality }));
vi.mock('../../stock/repository/stock-lane-routing.repository', () => ({ lockStockLaneTopology: mocks.topology }));
vi.mock('../../production/repository/production-preparation.repository', () => ({ preparationAudit: mocks.ofAudit }));
vi.mock('../../audit-logs/repository/audit-logs.repository', () => ({ repoInsertAuditLog: mocks.audit }));
vi.mock('../../../shared/realtime/realtime-outbox.service', () => ({ enqueueEntityChanged: mocks.enqueue }));
import { repoWithdrawDeliveryUrgency } from './delivery-urgency-withdrawal.repository';
import type { AuditContext } from '../../production/repository/production.repository';

const audit: AuditContext = { user_id: 8, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };
const args = { requestId: 'request', expectedVersion: 2, previewHash: 'a'.repeat(64), idempotencyKey: 'key', audit };
let previous: { request_hash: string; response: unknown } | null, control: ReturnType<typeof initial>;
function initial() {
  return { approval: { id: 'approval' }, response: { request_version: 2, preview_hash: args.previewHash, can_withdraw: true, issues: [] },
    current: { request: { quantity: '2.5', beneficiary_allocation_id: 1 }, basis: 'basis',
      sources: [{ id: 'source', donor_reservation_id: 'donor', quantity: '2.5' }],
      recoveries: [{ donor_allocation_id: 2, recovery_of_id: 101, quantity: '2.5', protected_due_date: '2026-10-20' }],
      donorPlan: { context: { commande_id: 10, commande_ligne_id: 11, livraison_affaire_id: 12, article_id: 'article', unit: 'u' },
        donors: [{ reservation_id: 'donor', lot_id: 'lot', source_scope: 'NEW', allocation_id: 2, commande_id: 20,
          commande_ligne_id: 21, stock_level_id: 'level', stock_batch_id: 'batch', location_id: 'location' }] } } };
}
function query(sql: string, values: unknown[] = []) {
  if (sql.includes('FROM public.delivery_urgency_withdrawals')) return { rows: previous ? [previous] : [] };
  if (sql.includes('INSERT INTO public.delivery_urgency_withdrawals')) previous = { request_hash: String(values[9]), response: JSON.parse(String(values[7])) };
  return { rows: [], rowCount: 1 };
}
beforeEach(() => {
  vi.clearAllMocks(); previous = null; control = initial(); mocks.query.mockImplementation(query); mocks.read.mockImplementation(async () => structuredClone(control));
  mocks.transfer.mockResolvedValue({ source_id: 'source', donor_reservation_id: 'donor', beneficiary_reservation_id: 'beneficiary', quantity: '2.5', reservation_evidence: { before: {}, after: {} } });
  mocks.quality.mockResolvedValue(undefined); mocks.enqueue.mockResolvedValue(undefined);
});
describe('atomic urgency withdrawal', () => {
  it('rechecks under locks, writes its ledger and notifies both orders in the same transaction', async () => {
    const result = await repoWithdrawDeliveryUrgency(args);
    expect(result).toMatchObject({ replayed: false, withdrawal: { status: 'WITHDRAWN', request_version: 3, quantity: '2.5', recovery_of_ids: [101] } });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.quality).toHaveBeenCalledWith(expect.objectContaining({ lotId: 'lot', qty: 0, purpose: 'RESERVE' }));
    expect(mocks.transfer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sourceId: 'source', quantity: '2.5', beneficiary: control.current.donorPlan.context }));
    expect(mocks.refresh).toHaveBeenCalledWith(expect.anything(), [2]);
    expect(mocks.ofAudit).toHaveBeenCalledOnce(); expect(mocks.audit).toHaveBeenCalledOnce(); expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0][0]).toBe('BEGIN');
    expect(mocks.query.mock.calls[1][0]).toContain('SERIALIZABLE');
    expect(mocks.query.mock.calls.at(-1)![0]).toBe('COMMIT'); expect(mocks.release).toHaveBeenCalledOnce();
    expect(result.withdrawal).not.toHaveProperty('transfers.0.reservation_evidence');
  });
  it('replays a committed transfer without consuming stock or approving twice', async () => {
    const first = await repoWithdrawDeliveryUrgency(args);
    expect(await repoWithdrawDeliveryUrgency(args)).toEqual({ withdrawal: first.withdrawal, replayed: true });
    expect(mocks.transfer).toHaveBeenCalledOnce(); expect(mocks.read).toHaveBeenCalledTimes(2);
    await expect(repoWithdrawDeliveryUrgency({ ...args, expectedVersion: 3 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it.each(['version', 'hash', 'approval'] as const)('refuses stale or unapproved evidence: %s', async field => {
    if (field === 'version') control.response.request_version++;
    if (field === 'hash') control.response.preview_hash = 'b'.repeat(64);
    if (field === 'approval') control.response.can_withdraw = false;
    await expect(repoWithdrawDeliveryUrgency(args)).rejects.toMatchObject({ status: 409 });
    expect(mocks.transfer).not.toHaveBeenCalled(); expect(previous).toBeNull();
    expect(mocks.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
  });
  it('refuses changed evidence in the second read before transferring', async () => {
    mocks.read.mockResolvedValueOnce(structuredClone(control)).mockResolvedValueOnce({ ...control, response: { ...control.response, preview_hash: 'changed' } });
    await expect(repoWithdrawDeliveryUrgency(args)).rejects.toMatchObject({ code: 'URGENCY_WITHDRAWAL_CHANGED' });
    expect(mocks.transfer).not.toHaveBeenCalled(); expect(previous).toBeNull();
  });
  it('does not bypass a new quality block', async () => {
    mocks.quality.mockRejectedValueOnce(new Error('quality hold'));
    await expect(repoWithdrawDeliveryUrgency(args)).rejects.toThrow('quality hold');
    expect(mocks.transfer).not.toHaveBeenCalled(); expect(mocks.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
  });
  it('rolls back all earlier transfers if any destination cannot be reserved', async () => {
    control.current.sources.push({ id: 'source2', donor_reservation_id: 'donor2', quantity: '1' });
    control.current.donorPlan.donors.push({ ...control.current.donorPlan.donors[0], reservation_id: 'donor2' });
    mocks.transfer.mockResolvedValueOnce({ source_id: 'source' }).mockRejectedValueOnce(new Error('destination changed'));
    await expect(repoWithdrawDeliveryUrgency(args)).rejects.toThrow('destination changed');
    expect(mocks.transfer).toHaveBeenCalledTimes(2); expect(previous).toBeNull(); expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.at(-1)![0]).toBe('ROLLBACK'); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each(['40001', '55P03', '40P01'])('returns a retryable conflict for concurrent writes (%s)', async code => {
    mocks.query.mockImplementation((sql: string, values: unknown[]) => {
      if (sql.includes('FOR UPDATE')) throw Object.assign(new Error('concurrent'), { code });
      return query(sql, values);
    });
    await expect(repoWithdrawDeliveryUrgency(args)).rejects.toMatchObject({ status: 409, code: 'URGENCY_BUSY' });
    expect(mocks.transfer).not.toHaveBeenCalled(); expect(mocks.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
  });
  it('does not commit an unnotified or unaudited transfer', async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(repoWithdrawDeliveryUrgency(args)).rejects.toThrow('outbox unavailable');
    expect(mocks.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
  });
});
