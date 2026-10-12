import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ reserve: vi.fn() }));
vi.mock('./receipt-delivery-reservations.repository', () => ({ reserveProducedDeliveryDemands: mocks.reserve }));
import { reserveUrgencyRecoveryReceiptTx } from './urgency-recovery-receipt.repository';

const recovery = { id: 'recovery', request_id: 'request', status: 'WITHDRAWN', donor_allocation_id: 12,
  quantity: '20.000', restored: '0', commande_ligne_id: 21, livraison_affaire_id: 22, identity_valid: true };
const args = { receipt_id: 'receipt', of_id: 101, article_id: 'article', location_id: 'location',
  stock_level_id: 'level', stock_batch_id: 'batch', lot_id: 'lot', qty_ok: 12, actor_user_id: 8, quality_gate_already_held: true };
const tx = (data: unknown = recovery) => ({ query: vi.fn().mockImplementation(async (sql: string) => ({
  rows: sql.includes('SELECT recovery.id') && data ? [data] : [],
})) });
beforeEach(() => { vi.clearAllMocks(); mocks.reserve.mockImplementation(async (_db, input) => ({
  reservation_id: 'donor-reservation', reservation_ids: ['donor-reservation'], qty_reserved: input.qty_ok,
})); });
describe('released urgency recovery receipts', () => {
  it.each(['55P03', '40P01', '40001'])('returns a reloadable conflict for concurrent receipt code %s', async code => {
    const db = tx(); db.query.mockRejectedValueOnce(Object.assign(new Error('concurrent change'), { code }));
    await expect(reserveUrgencyRecoveryReceiptTx(db, args)).rejects.toMatchObject({ status: 409, code: 'URGENCY_RECOVERY_BUSY' });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('leaves ordinary production and assembly to the existing receipt routing', async () => {
    expect(await reserveUrgencyRecoveryReceiptTx(tx(null), args)).toBeNull();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('repays the original donor and records the exact released partial quantity', async () => {
    const db = tx();
    expect(await reserveUrgencyRecoveryReceiptTx(db, args)).toMatchObject({ matched: true, qty_reserved: 12 });
    expect(mocks.reserve).toHaveBeenCalledWith(db, expect.objectContaining({ commande_ligne_id: 21,
      livraison_affaire_id: 22, of_id: 101, qty_ok: 12, quality_gate_already_held: true }));
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO public.delivery_urgency_replenishments'),
      ['recovery', 'receipt', 'donor-reservation', 'lot', '12', 8]);
  });
  it('reserves only the outstanding debt and leaves excess production free', async () => {
    expect(await reserveUrgencyRecoveryReceiptTx(tx({ ...recovery, restored: '17.125' }), args))
      .toMatchObject({ qty_reserved: 2.875 });
    expect(mocks.reserve.mock.calls[0][1].qty_ok).toBe(2.875);
  });
  it('does not count already repaid production twice', async () => {
    const db = tx({ ...recovery, restored: '20' });
    expect(await reserveUrgencyRecoveryReceiptTx(db, args)).toMatchObject({ matched: true, qty_reserved: 0 });
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(db.query).toHaveBeenCalledOnce();
  });
  it.each(['APPROVED', 'CANCELLED'])('does not invent a repayment for a %s request', async status => {
    expect(await reserveUrgencyRecoveryReceiptTx(tx({ ...recovery, status }), args)).toMatchObject({ qty_reserved: 0 });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('rejects a recovery without planner approval', async () => {
    await expect(reserveUrgencyRecoveryReceiptTx(tx({ ...recovery, status: 'WAITING_PLANNER' }), args))
      .rejects.toMatchObject({ code: 'URGENCY_RECOVERY_NOT_APPROVED' });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('does not silently redirect recovery production after its OF links change', async () => {
    await expect(reserveUrgencyRecoveryReceiptTx(tx({ ...recovery, identity_valid: false }), args))
      .rejects.toMatchObject({ code: 'URGENCY_RECOVERY_DESTINATION_CHANGED' });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('counts only the quantity actually reserved when the donor has other coverage', async () => {
    const db = tx(); mocks.reserve.mockResolvedValue({ reservation_id: 'hold', reservation_ids: ['hold'], qty_reserved: 3 });
    expect(await reserveUrgencyRecoveryReceiptTx(db, args)).toMatchObject({ qty_reserved: 3 });
    expect(db.query).toHaveBeenLastCalledWith(expect.any(String), ['recovery','receipt','hold','lot','3',8]);
  });
  it('leaves output free when the donor has already been covered', async () => {
    const db = tx(); mocks.reserve.mockResolvedValue(null);
    expect(await reserveUrgencyRecoveryReceiptTx(db, args)).toMatchObject({ qty_reserved: 0 });
    expect(db.query).toHaveBeenCalledOnce();
  });
  it('propagates quality, stock or reservation conflicts without recording a repayment', async () => {
    const db = tx(); mocks.reserve.mockRejectedValue(new Error('quality conflict'));
    await expect(reserveUrgencyRecoveryReceiptTx(db, args)).rejects.toThrow('quality conflict');
    expect(db.query).toHaveBeenCalledOnce();
  });
  it('rejects ambiguous allocation instead of attributing another affair', async () => {
    const db = tx(); mocks.reserve.mockResolvedValue({ reservation_id: 'a', reservation_ids: ['a','b'], qty_reserved: 12 });
    await expect(reserveUrgencyRecoveryReceiptTx(db, args)).rejects.toMatchObject({ code: 'URGENCY_RECOVERY_ALLOCATION_AMBIGUOUS' });
    expect(db.query).toHaveBeenCalledOnce();
  });
});
