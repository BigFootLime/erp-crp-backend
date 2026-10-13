import { beforeEach, describe, expect, it, vi } from 'vitest';
const reserve = vi.hoisted(() => vi.fn());
vi.mock('../../production/repository/receipt-delivery-reservations.repository', () => ({ reserveProducedDeliveryDemands: reserve }));
import { transferUrgencyReservationTx } from './urgency-withdrawal-stock.repository';
import type { DeliveryUrgencyDonor } from './delivery-urgency.repository';
const query = vi.fn();
const source = { reservation_id: 'donor', reservation_version: 3, article_id: 'article', location_id: 'location',
  lot_id: 'lot', stock_level_id: 'level', stock_batch_id: 'batch', source_scope: 'OLD' } as DeliveryUrgencyDonor;
const args = { sourceId: 'source', source, quantity: '0.125', requestId: 'request', actor: 8,
  beneficiary: { commande_ligne_id: 11, livraison_affaire_id: 12, article_id: 'article' } };
function defaultQuery(sql: string) {
  if (sql.startsWith('SELECT')) return { rows: [{ snapshot: { id: 'snapshot', scope: 'OLD' } }], rowCount: 1 };
  return { rows: [{ snapshot: { id: 'after' } }], rowCount: 1 };
}
beforeEach(() => {
  vi.clearAllMocks(); query.mockImplementation(defaultQuery);
  reserve.mockResolvedValue({ reservation_id: 'beneficiary', reservation_ids: ['beneficiary'], qty_reserved: 0.125 });
});
describe('reservation reassignment', () => {
  it('preserves the original lot, scope and exact decimal quantity through the canonical allocator', async () => {
    expect(await transferUrgencyReservationTx({ query }, args)).toMatchObject({ source_id: 'source', donor_reservation_id: 'donor',
      beneficiary_reservation_id: 'beneficiary', quantity: '0.125', reservation_evidence: { before: { scope: 'OLD' }, after: { id: 'after' } } });
    expect(reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ...args.beneficiary, location_id: 'location',
      lot_id: 'lot', stock_level_id: 'level', stock_batch_id: 'batch', source_scope: 'OLD', qty_ok: 0.125, quality_gate_already_held: true }));
  });
  it('stops before reserving the destination if the donor version or available amount changed', async () => {
    query.mockImplementation((sql: string) => sql.startsWith('UPDATE public.stock_reservations') ? { rows: [], rowCount: 0 } : defaultQuery(sql));
    await expect(transferUrgencyReservationTx({ query }, args)).rejects.toMatchObject({ code: 'URGENCY_DONOR_CHANGED' });
    expect(reserve).not.toHaveBeenCalled();
  });
  it('rejects missing physical reservation coverage rather than silently reducing stock', async () => {
    query.mockImplementation((sql: string) => sql.startsWith('UPDATE public.stock_batches') ? { rows: [], rowCount: 0 } : defaultQuery(sql));
    await expect(transferUrgencyReservationTx({ query }, args)).rejects.toMatchObject({ code: 'URGENCY_STOCK_CHANGED' });
    expect(reserve).not.toHaveBeenCalled();
  });
  it.each([null, { reservation_id: 'beneficiary', reservation_ids: ['beneficiary'], qty_reserved: 0.1 },
    { reservation_id: 'beneficiary', reservation_ids: ['beneficiary', 'other'], qty_reserved: 0.125 }])('requires the whole amount on the one intended affair', async result => {
    reserve.mockResolvedValueOnce(result);
    await expect(transferUrgencyReservationTx({ query }, args)).rejects.toMatchObject({ code: 'URGENCY_BENEFICIARY_CHANGED' });
  });
});
