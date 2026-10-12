import { describe, expect, it } from 'vitest';
import { cuttingScanSource, type CuttingScanNeed } from './station-cutting-scan';
const needs = (): CuttingScanNeed[] => [{ operationId: 'cut', reservations: [{ id: 'res', lot_id: 'lot', stock_batch_id: 'batch', status: 'ACTIVE', unexpired: true, qty_reserved: 6000, qty_consumed: 0, lot_status: 'LIBERE' }],
  candidates: [{ lot: { id: 'lot', batchId: 'batch', code: 'LOT-STEEL' } }],
  barInventories: { batch: { status: 'CONFIRMED', bars: [{ id: 'bar1', code: 'BAR-000001', lengthMm: 3000 }, { id: 'bar2', code: 'BAR-000002', lengthMm: 3000 }],
    holds: [{ barId: 'bar1', reservationId: 'res', remainingMm: 3000 }, { barId: 'bar2', reservationId: 'res', remainingMm: 3000 }] } },
}] as unknown as CuttingScanNeed[];
describe('bar scan bound to the cutting operation', () => {
  it('resolves exactly the second bar even if both share one lot and reservation', () => {
    expect(cuttingScanSource(needs(), 'cut', { type: 'STOCK_MATERIAL_BAR', id: 'bar2', code: 'BAR-000002' })).toMatchObject({
      lotId: 'lot', lotCode: 'LOT-STEEL', barId: 'bar2', barCode: 'BAR-000002', reservationIds: ['res'],
    });
  });
  it('keeps a lot scan as a lot filter without silently choosing a physical bar', () => {
    const result = cuttingScanSource(needs(), 'cut', { type: 'STOCK_LOT', id: 'lot', code: 'LOT-STEEL' });
    expect(result).toMatchObject({ lotId: 'lot', reservationIds: ['res'] });
    expect(result).not.toHaveProperty('barId');
  });
  it.each(['different-operation', 'another-OF'])('refuses a bar outside the selected context: %s', operationId => {
    expect(() => cuttingScanSource(needs(), operationId, { type: 'STOCK_MATERIAL_BAR', id: 'bar2', code: 'BAR-000002' })).toThrow('pas réservée');
  });
  it.each(['REVIEW_REQUIRED','UNCONFIRMED'] as const)('refuses unconfirmed geometry: %s', status => {
    const data=needs();data[0].barInventories!.batch.status=status;
    expect(() => cuttingScanSource(data,'cut',{type:'STOCK_MATERIAL_BAR',id:'bar2',code:'BAR-000002'})).toThrow('pas réservée');
  });
  it('refuses an exhausted bar, a foreign hold and a lot blocked by quality', () => {
    const data=needs(),bar=data[0].barInventories!.batch.bars[1];
    bar.lengthMm=0;expect(()=>cuttingScanSource(data,'cut',{type:'STOCK_MATERIAL_BAR',id:'bar2',code:'BAR-000002'})).toThrow();
    bar.lengthMm=3000;data[0].barInventories!.batch.holds[1].reservationId='someone-else';
    expect(()=>cuttingScanSource(data,'cut',{type:'STOCK_MATERIAL_BAR',id:'bar2',code:'BAR-000002'})).toThrow();
    data[0].reservations=[{...data[0].reservations[0],lot_status:'BLOQUE'}];
    expect(()=>cuttingScanSource(data,'cut',{type:'STOCK_LOT',id:'lot',code:'LOT-STEEL'})).toThrow();
  });
});
