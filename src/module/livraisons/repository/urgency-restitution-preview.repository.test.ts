import { beforeEach, describe, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ quality: vi.fn(), routing:vi.fn() }));
vi.mock('../../qualite/repository/quality-operational-gate.repository', () => ({ readOperationalLotQualityEligibility: ports.quality }));
vi.mock('../../stock/repository/stock-lane-routing.repository',()=>({readStockLaneRoutingTx:ports.routing}));
import { readUrgencyRestitutionTx } from './urgency-restitution-preview.repository';

function fixture() {
  const request = { status: 'WITHDRAWN', quantity: '10', commande_id: '1' };
  const recovery = { id: 'r', quantity: '10', replenished: '4', donor_uncovered: '6' };
  const reservation = { id: 'held', remaining: '10', prepared: '0', consumed: '0', snapshot: { version: 2 },
    lot_id: 'lot', lot_status: 'LIBERE', expiry_at: null as string | null, source_scope: 'NEW',
    old_documents: false, physical_covered: true, identity_valid: true };
  const fee = { id: 'charge', amount_ht: '50.00', currency: 'EUR', invoice_id: 'invoice', invoice_number: 'FA-1', invoice_status: 'ISSUED', other_withdrawals: 1 };
  const db = { query: vi.fn().mockImplementation(async (sql: string) => ({ rows:
    sql.includes('SELECT request.quantity') ? [request] : sql.includes('SELECT recovery.id') ? [recovery] :
    sql.includes('SELECT transfer.id') ? [{ id: 't', recovery_id: 'r', reservation_id: 'held', quantity: '10' }] :
    sql.includes('SELECT reservation.id') ? [reservation] : sql.includes('SELECT charge.id') ? [fee] : [] })) };
  return { db, request, recovery, reservation, fee };
}

describe('urgency restitution review', () => {
  beforeEach(() => { vi.resetAllMocks(); ports.routing.mockResolvedValue({routing_active:true,destinations:[]}); ports.quality.mockResolvedValue({ eligibility: { allowed: true, blocks: [] } }); });
  it('reads physical stock and retained financial evidence without any write', async () => {
    const { db, fee } = fixture(); const result = await readUrgencyRestitutionTx(db, 'request');
    expect(result.response).toMatchObject({ can_restore: true, donor_quantity: '6', free_quantity: '4', fee });
    expect(db.query.mock.calls.every(([sql]) => /^SELECT /.test(sql))).toBe(true);
    expect(ports.quality).toHaveBeenCalledWith(expect.objectContaining({ qty: 0, purpose: 'RESERVE' }));
  });
  it.each(['WAITING_PLANNER', 'APPROVED', 'CANCELLED'])('refuses a restitution review of %s', async status => {
    const { db, request } = fixture(); request.status = status;
    await expect(readUrgencyRestitutionTx(db, 'request')).rejects.toMatchObject({ code: 'URGENCY_NOT_WITHDRAWN' });
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it('stops when the physical stock no longer covers its reservations', async () => {
    const { db, reservation } = fixture(); reservation.physical_covered = false;
    expect((await readUrgencyRestitutionTx(db, 'request')).response).toMatchObject({ can_restore: false,
      issues: [{ code: 'URGENCY_RETURN_STOCK_BLOCKED', message: expect.stringContaining('physique') }] });
    expect(ports.quality).not.toHaveBeenCalled();
  });
  it('keeps a current quality refusal as an actionable blocker', async () => {
    ports.quality.mockResolvedValue({ eligibility: { allowed: false, blocks: [{ message: 'CQ à compléter.' }] } });
    expect((await readUrgencyRestitutionTx(fixture().db, 'request')).response.issues[0].message).toBe('CQ à compléter.');
  });
  it('does not ignore a missing OLD document link', async () => {
    const { db, reservation } = fixture(); reservation.source_scope = 'OLD';
    expect((await readUrgencyRestitutionTx(db, 'request')).response.can_restore).toBe(false);
    reservation.old_documents = true;
    expect((await readUrgencyRestitutionTx(db, 'request')).response.can_restore).toBe(true);
    expect(ports.quality).not.toHaveBeenCalled();
  });
  it('blocks expired lots instead of returning them to usable stock', async () => {
    const { db, reservation } = fixture(); reservation.expiry_at = '2000-01-01';
    expect((await readUrgencyRestitutionTx(db, 'request')).response.issues[0].message).toBe('Lot périmé.');
  });
});
