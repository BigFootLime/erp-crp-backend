import { describe, expect, it } from 'vitest';
import { materialBalance, materialReservedCapacity, materialSelectionCoverage, proposeMaterialCoverage, type MaterialLot, type MaterialNeed } from './of-material';
import { physicalMaterialInventoryBlockers, physicalMaterialSelection, type MaterialBarCoverage } from './of-material-bars';

const inventory = (lengths: number[], holds: MaterialBarCoverage['holds'] = []): MaterialBarCoverage => ({
  status: 'CONFIRMED', version: 'inventory-1', warning: null, holds,
  bars: lengths.map((lengthMm, i) => ({ id: `bar-${i}`, batchId: 'batch', lengthMm, version: 1 })),
});
const reservation = (id: string, qty: number) => ({ id, stock_batch_id: 'batch', status: 'ACTIVE', unexpired: true, qty_reserved: qty, qty_consumed: 0 });
const need = (geometry: MaterialBarCoverage, overrides: Partial<MaterialNeed> = {}): MaterialNeed => ({
  key: 'need', articleId: 'article', unit: 'mm', required: 331.5, reserved: 0, consumed: 0, expected: 0, receivedBlocked: 0,
  requirements: { grade: null, condition: null, ownerClientId: null, dimensions: {}, certificates: [], manualChecks: [] },
  debitRule: { form: 'BAR', stockUnit: 'mm', unitsPerBlank: 110, kerfPerBlank: .5, yieldValidated: true },
  reservations: [], barInventories: { batch: geometry }, ...overrides,
});
const lot = (available: number): MaterialLot => ({ id: 'lot', batchId: 'batch', articleId: 'article', code: 'LOT', unit: 'mm', quality: 'LIBERE',
  available, receivedAt: '2026-01-01', grade: null, condition: null, ownerClientId: null, dimensions: {}, certificates: [], manualVerified: false });

describe('OF coverage from physical bars', () => {
  it('counts two separate 200 mm remnants as two blanks, not three, even in the same batch', () => {
    const n = need(inventory([200, 200], [{ barId: 'bar-0', reservationId: 'r', remainingMm: 200 }, { barId: 'bar-1', reservationId: 'r', remainingMm: 200 }]),
      { reserved: 400, reservations: [reservation('r', 400)] });
    expect(materialReservedCapacity(n)).toBe(221);
    expect(materialBalance(n).missing).toBe(110.5);
    expect(proposeMaterialCoverage([n], [lot(0)])[0].purchaseMissing).toBe(110.5);
  });
  it('combines accounting reservations only when they hold the same physical bar', () => {
    const n = need(inventory([400], [{ barId: 'bar-0', reservationId: 'r1', remainingMm: 200 }, { barId: 'bar-0', reservationId: 'r2', remainingMm: 200 }]),
      { reserved: 400, reservations: [reservation('r1', 200), reservation('r2', 200)] });
    expect(materialReservedCapacity(n)).toBe(331.5);
  });
  it('tops up 210 mm on the same bar by 11 mm and preserves its version for the reservation command', () => {
    const n = need(inventory([1000], [{ barId: 'bar-0', reservationId: 'r', remainingMm: 210 }]),
      { required: 221, reserved: 210, reservations: [reservation('r', 210)] });
    const result = proposeMaterialCoverage([n], [lot(790)])[0];
    expect(result.selections).toEqual([{ batchId: 'batch', lotId: 'lot', quantity: 11,
      barAllocations: [{ barId: 'bar-0', batchId: 'batch', expectedVersion: 1, quantityMm: 11 }] }]);
    expect(result.purchaseMissing).toBe(0);
    expect(materialSelectionCoverage(n, [{ batchId: 'batch', quantity: 11 }])).toBe(110.5);
    expect(materialSelectionCoverage(n, [{ batchId: 'batch', quantity: 10.999 }])).toBe(0);
  });
  it('never uses another need’s held remainder to finish a blank', () => {
    const n = need(inventory([200], [{ barId: 'bar-0', reservationId: 'other', remainingMm: 100 }]));
    expect(physicalMaterialSelection(n, 'batch', 100).quantity).toBe(0);
  });
  it('shares physical free lengths across need proposals, including consecutive repository calls', () => {
    const n = need(inventory([200, 200]), { required: 110.5 }), shared = new Map<string, number>();
    const first = proposeMaterialCoverage([n], [lot(400)], undefined, shared)[0];
    const second = proposeMaterialCoverage([{ ...n, key: 'second' }], [lot(289.5)], undefined, shared)[0];
    const third = proposeMaterialCoverage([{ ...n, key: 'third' }], [lot(179)], undefined, shared)[0];
    expect(first.selections[0].barAllocations?.[0].barId).toBe('bar-0');
    expect(second.selections[0].barAllocations?.[0].barId).toBe('bar-1');
    expect(third.selections).toEqual([]);
    expect(third.purchaseMissing).toBe(110.5);
  });
  it('respects both quality and location budgets even if longer bars physically exist', () => {
    const n = need(inventory([1000]));
    expect(proposeMaterialCoverage([n], [{ ...lot(1000), qualityAvailable: 110.5 }])[0].selections[0].quantity).toBe(110.5);
    expect(proposeMaterialCoverage([n], [{ ...lot(1000), stockLevelId: 'level', levelAvailable: 100 }])[0].selections).toEqual([]);
  });
  it('completes all cheap partial blanks before spending a limited budget on full blanks', () => {
    const geometry = inventory([400, 400, 400], [
      { barId: 'bar-0', reservationId: 'r', remainingMm: 10.5 },
      { barId: 'bar-1', reservationId: 'r', remainingMm: 105.5 },
      { barId: 'bar-2', reservationId: 'r', remainingMm: 105.5 },
    ]);
    const n = need(geometry, { reserved: 221.5, reservations: [reservation('r', 221.5)] });
    const result = proposeMaterialCoverage([n], [{ ...lot(978.5), qualityAvailable: 100 }])[0];
    expect(result.selections[0].quantity).toBe(10);
    expect(result.selections[0].barAllocations?.map(a => a.barId)).toEqual(['bar-1', 'bar-2']);
    expect(result.purchaseMissing).toBe(110.5);
  });
  it.each(['UNCONFIRMED', 'REVIEW_REQUIRED'] as const)('does not infer geometry from a %s inventory or silently buy its stock again', status => {
    const geometry = { ...inventory([1000]), status, warning: 'Vérifier les barres.' };
    const n = need(geometry, { reserved: 100, reservations: [reservation('r', 100)] });
    expect(materialReservedCapacity(n)).toBe(0);
    expect(physicalMaterialInventoryBlockers(n)).toEqual(['Vérifier les barres.']);
    const proposal = proposeMaterialCoverage([n], [lot(900)])[0];
    expect(proposal.selections).toEqual([]);
    expect(proposal.purchaseRequiresBarReview).toBe(true);
  });
  it('does not let absent or expired reservations claim geometry held by another source', () => {
    const geometry = inventory([400], [{ barId: 'bar-0', reservationId: 'r', remainingMm: 400 }]);
    expect(materialReservedCapacity(need(geometry, { reserved: 400, reservations: [{ ...reservation('r', 400), unexpired: false }] }))).toBe(0);
    expect(materialReservedCapacity(need(geometry, { reserved: 400, reservations: [], barInventories: {} }))).toBe(0);
  });
  it('counts several bars of one critical lot as one material origin', () => {
    const n = need(inventory([200, 200]), { required: 221 });
    const result = proposeMaterialCoverage([n], [lot(400)], { maximumLots: 1, usedOrigins: new Set(), originsByLot: { lot: ['origin'] } })[0];
    expect(result.selections[0].barAllocations).toHaveLength(2);
    expect(result.purchaseMissing).toBe(0);
  });
  it('ignores geometry for unit-managed stock and leaves an already-covered bar need untouched', () => {
    const geometry = inventory([200]);
    const unitNeed = need(geometry, { debitRule: { form: 'UNIT', stockUnit: 'u', unitsPerBlank: 1, kerfPerBlank: 0, yieldValidated: true }, reserved: 3 });
    expect(materialReservedCapacity(unitNeed)).toBe(3);
    expect(proposeMaterialCoverage([need(geometry, { required: 0 })], [lot(200)])[0].selections).toEqual([]);
  });
});
