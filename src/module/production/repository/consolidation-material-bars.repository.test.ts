import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { AuditContext } from './production.repository';
const mocks = vi.hoisted(() => ({ read: vi.fn(), availability: vi.fn(), policy: vi.fn(), reserve: vi.fn(), aggregate: vi.fn(), inventory: vi.fn() }));
vi.mock('./of-material.repository', () => ({ readMaterialTx: mocks.read }));
vi.mock('./material-reservation-availability.repository', () => ({ readMaterialReservationAvailabilityTx: mocks.availability }));
vi.mock('./of-material-policy.repository', () => ({ readMaterialOriginPolicyTx: mocks.policy }));
vi.mock('../../stock/repository/stock-reservation.repository', () => ({ repoCreateStockReservation: mocks.reserve }));
vi.mock('./consolidation-material-holds.repository', () => ({ aggregateConsolidationHoldsTx: mocks.aggregate }));
vi.mock('../../stock/repository/material-bar-holds.repository', () => ({ readTrackedMaterialBarInventoryTx: mocks.inventory }));
import { previewConsolidationMaterialTx, transferConsolidationMaterialTx } from './consolidation-material.repository';

const requirements = { grade: null, condition: null, ownerClientId: null, dimensions: {}, certificates: [], manualChecks: [] };
function fixture(id: number, lengths = [1000]) {
  const lot = { id: 'lot', batchId: 'batch', articleId: 'article', code: 'LOT', unit: 'mm', quality: 'LIBERE',
    available: lengths.reduce((a, b) => a + b, 0) - 221, receivedAt: '2026-01-01', ...requirements,
    manualVerified: true, qualityAvailable: lengths.reduce((a, b) => a + b, 0) - 221, magasinId: 'store', emplacementId: 1 };
  return { ofId: id, version: `version${id}`, previousNeeds: [], operations: [{ id: `op${id}`, phase: 10 }],
    needs: [{ key: 'material', id: `need${id}`, articleId: 'article', designation: 'Barre acier', unit: 'mm', required: 110.5,
      reserved: 110.5, consumed: 0, expected: 0, receivedBlocked: 0, reviewed: true, blockers: [], operationId: `op${id}`,
      supplyMode: 'PURCHASE', requirements, supplierId: null, destinationId: null,
      debitRule: { form: 'BAR', stockUnit: 'mm', unitsPerBlank: 110, kerfPerBlank: .5, yieldValidated: true },
      reservations: [{ id: `r${id}`, stock_batch_id: 'batch', lot_id: 'lot', material_need_id: `need${id}`, status: 'ACTIVE', unexpired: true, qty_reserved: 110.5, qty_consumed: 0 }],
      candidates: [{ lot, available: lot.available }],
      barInventories: { batch: { status: 'CONFIRMED', version: 'bars', warning: null,
        bars: lengths.map((lengthMm, i) => ({ id: `bar${i}`, batchId: 'batch', lengthMm, version: 1 })),
        holds: [{ barId: 'bar0', reservationId: 'r1', remainingMm: 110.5 }, { barId: lengths.length > 1 ? 'bar1' : 'bar0', reservationId: 'r2', remainingMm: 110.5 }] } },
    }] };
}
const tx = { query: vi.fn() } as unknown as PoolClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockImplementation(async (_tx, id) => fixture(id));
  mocks.availability.mockResolvedValue(new Map([['material', { usable: 110.5, blockers: [] }]]));
  mocks.policy.mockResolvedValue({ maximumLots: 2, usedOrigins: new Set(['lot']), originsByLot: { lot: ['lot'] } });
  vi.mocked(tx.query).mockResolvedValue({ rows: [{ id: 'producerNeed' }] } as never);
  mocks.reserve.mockResolvedValue({ reservation: { id: 'surplus' } });
});

describe('consolidation physical surplus', () => {
  it('counts both source OF holds before reserving one additional blank', async () => {
    const result = await previewConsolidationMaterialTx(tx, [1, 2], 3);
    expect(result.groups[0].extra).toEqual([expect.objectContaining({ quantity: 110.5,
      barAllocations: [{ barId: 'bar0', batchId: 'batch', quantityMm: 110.5, expectedVersion: 1 }] })]);
  });
  it('does not reserve already covered source quantities twice', async () => {
    expect((await previewConsolidationMaterialTx(tx, [1, 2], 2)).groups[0].extra).toEqual([]);
  });
  it('refuses fictitious surplus made from two short remainders', async () => {
    mocks.read.mockImplementation(async (_tx, id) => fixture(id, [200, 200]));
    await expect(previewConsolidationMaterialTx(tx, [1, 2], 3)).rejects.toMatchObject({ code: 'CONSOLIDATION_MATERIAL_MISSING' });
  });
  it('shares the physical bar budget between two material needs', async () => {
    mocks.read.mockImplementation(async (_tx, id) => {
      const data = fixture(id, [552.5, 60, 60]);
      const second = structuredClone(data.needs[0]); second.key = 'second'; second.id = `second${id}`;
      second.reservations = [{ ...second.reservations[0], id: `s${id}`, material_need_id: second.id }];
      for (const n of [data.needs[0], second]) {
        n.candidates[0].available = n.candidates[0].lot.available = n.candidates[0].lot.qualityAvailable = 230.5;
        n.barInventories.batch.holds[1].barId = 'bar0';
        n.barInventories.batch.holds.push({ barId: 'bar0', reservationId: 's1', remainingMm: 110.5 }, { barId: 'bar0', reservationId: 's2', remainingMm: 110.5 });
      }
      data.needs.push(second); return data;
    });
    mocks.availability.mockResolvedValue(new Map(['material', 'second'].map(key => [key, { usable: 110.5, blockers: [] }])));
    await expect(previewConsolidationMaterialTx(tx, [1, 2], 3)).rejects.toMatchObject({ code: 'CONSOLIDATION_MATERIAL_MISSING' });
  });
  it('reserves the proposed bars with their current locked version before ownership aggregation', async () => {
    const result = await previewConsolidationMaterialTx(tx, [1, 2], 3);
    mocks.inventory.mockResolvedValue({ bars: [{ id: 'bar0', version: 4 }] });
    await transferConsolidationMaterialTx(tx, 'group', 3, result, { user_id: 1 } as AuditContext);
    expect(mocks.reserve.mock.calls[0][0].barAllocations).toEqual([{ barId: 'bar0', quantityMm: 110.5, expectedVersion: 4 }]);
    expect(mocks.aggregate).toHaveBeenCalledWith(tx, expect.objectContaining({ surplusReservationIds: ['surplus'],
      sources: [{ ofId: 1, needId: 'need1', reservations: ['r1'] }, { ofId: 2, needId: 'need2', reservations: ['r2'] }] }), expect.anything());
  });
  it('refuses a disappeared bar before creating any surplus reservation', async () => {
    const result = await previewConsolidationMaterialTx(tx, [1, 2], 3); mocks.inventory.mockResolvedValue({ bars: [] });
    await expect(transferConsolidationMaterialTx(tx, 'group', 3, result, { user_id: 1 } as AuditContext))
      .rejects.toMatchObject({ code: 'CONSOLIDATION_MATERIAL_CHANGED' });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
