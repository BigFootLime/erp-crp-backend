import { describe, expect, it } from 'vitest';
import { planMaterialBarQuality } from './material-bar-quality';
import { reconcileMaterialBars, proposeMaterialBarAllocation, consumeMaterialBar } from './material-bars';
import { planMaterialBarMovement, type MaterialBarQualityCommand } from './material-bar-movement';
import { planMaterialBarReservation } from '../repository/material-bar-holds.repository';
import { validateMaterialBarCount } from '../repository/material-bar-count.repository';
import type { MaterialBarInventory } from '../repository/material-bar-inventory.repository';
import { materialBarMovementCommandSchema } from '../validators/material-bar-movement.validators';

function stock(): MaterialBarInventory {
  return { version: 'a'.repeat(64), revision: 1, status: 'CONFIRMED', warning: null,
    batch: { id: 'batch', lotId: 'lot', articleId: 'article', physicalMm: 6000, reservedMm: 0, depreciatedMm: 3000,
      movementCount: '1', levelId: 'level', lotCode: 'LOT', articleCode: 'MP', designation: 'Barres de recette', unit: 'mm' },
    bars: [ { id: 'bad', batchId: 'batch', lengthMm: 3000, initialLengthMm: 3000, depreciatedMm: 3000, version: 2, createdAt: '2026-10-12' },
      { id: 'good', batchId: 'batch', lengthMm: 3000, initialLengthMm: 3000, depreciatedMm: 0, version: 1, createdAt: '2026-10-12' } ],
    holds: [], reservations: [] };
}
const command = (quantityMm=1000): MaterialBarQualityCommand => ({ kind: 'DEPRECIATE', expectedVersion: 'a'.repeat(64),
  bars: [{ barId: 'good', expectedVersion: 1, quantityMm }] });
const inventory = (s=stock()) => reconcileMaterialBars({ bars: s.bars, holds: s.holds, batches: [s.batch], reservations: s.reservations });

describe('physical quality and usable bar capacity', () => {
  it('retains physical length while assigning the exact new depreciation', () => {
    const s=stock(), before=JSON.stringify(s), plan=planMaterialBarQuality(s, 1000, command());
    expect(plan.changes[0]).toMatchObject({ bar: { lengthMm: 3000 }, depreciatedMm: 1000, nextVersion: 2 });
    expect(JSON.stringify(s)).toBe(before);
  });
  it('never proposes a depreciated bar even when the batch has free capacity', () => {
    expect(proposeMaterialBarAllocation({ inventory: inventory(), reservationIds: [], requiredBlanks: 3, blankLengthMm: 1500, kerfMm: 0 }))
      .toMatchObject({ missingBlanks: 1, allocations: [{ barId: 'good', quantityMm: 3000 }] });
  });
  it('does not reserve a rejected bar by explicit selection or FIFO fallback', () => {
    expect(planMaterialBarReservation(stock(), 3000)).toEqual([{ barId: 'good', quantityMm: 3000, expectedVersion: 1 }]);
    expect(() => planMaterialBarReservation(stock(), 1, [{ barId: 'bad', expectedVersion: 2, quantityMm: 1 }])).toThrow();
  });
  it('requires historical aggregate depreciation to be identified on actual bars', () => {
    const s=stock();s.bars[0].depreciatedMm=0;expect(() => inventory(s)).toThrow('Affectez');
  });
  it('preserves OF reservations when recording a quality decision', () => {
    const s=stock();s.batch.reservedMm=2500;s.reservations=[{ id:'r',batchId:'batch',remainingMm:2500,version:1,ofId:1,ofNumber:'OF-1' }];
    s.holds=[{ barId:'good',reservationId:'r',remainingMm:2500 }];
    expect(() => planMaterialBarQuality(s,1000,command())).toThrow('Réaffectez');
    expect(planMaterialBarQuality(s,500,command(500)).changes[0].depreciatedMm).toBe(500);
  });
  it('rejects repeated, stale, wrong-total and overdrawn quality selections', () => {
    const c=command();
    for (const invalid of [{...c,expectedVersion:'stale'}, {...c,bars:[...c.bars,...c.bars]}, command(999),
      {...c,bars:[{barId:'bad',expectedVersion:2,quantityMm:1000}]}, {...c,bars:[{barId:'good',expectedVersion:5,quantityMm:1000}]}])
      expect(() => planMaterialBarQuality(stock(),1000,invalid)).toThrow();
  });
  it('cannot post a physical issue against the unusable part', () => {
    const s=stock();s.bars[0].depreciatedMm=2000;s.batch.depreciatedMm=2000;
    const c={kind:'ISSUE' as const,expectedVersion:s.version,bars:[{barId:'bad',expectedVersion:2,quantityMm:1000}]};
    expect(planMaterialBarMovement({source:s,quantityMm:1000,command:c})).toMatchObject({changes:[{remainingMm:2000}]});
    expect(() => planMaterialBarMovement({source:s,quantityMm:1001,command:{...c,bars:[{...c.bars[0],quantityMm:1001}]}})).toThrow();
  });
  it('cannot close a bar while silently discarding its already depreciated part', () => {
    expect(() => consumeMaterialBar({bar:stock().bars[0],expectedVersion:2,cutMm:1,discardedMm:2999,close:true,acknowledgedLargeRemainder:true,heldByOtherNeedsMm:0})).toThrow();
  });
  it('cannot transfer depreciation through a normal transfer with unchanged quality balances', () => {
    const s=stock();expect(() => planMaterialBarMovement({source:s,quantityMm:3000,command:{kind:'TRANSFER',expectedVersion:s.version,
      expectedDestinationVersion:s.version,bars:[{barId:'bad',expectedVersion:2}]}})).toThrow('dépréciée');
  });
  it('counting cannot erase aggregate depreciation and detects same-total allocation changes', () => {
    const s=stock(), body={ expectedVersion:s.version,idempotencyKey:'count',reason:'Mesure physique',
      bars:s.bars.map(b=>({id:b.id,lengthMm:b.lengthMm,depreciatedMm:b.depreciatedMm,allocations:[]})) };
    expect(validateMaterialBarCount(s,body,6000).geometryChanged).toBe(false);
    expect(() => validateMaterialBarCount(s,{...body,bars:body.bars.map(b=>({...b,depreciatedMm:0}))},6000)).toThrow('Affectez');
    expect(validateMaterialBarCount(s,{...body,bars:body.bars.map(b=>({...b,depreciatedMm:b.id==='good'?3000:0}))},6000).geometryChanged).toBe(true);
  });
  it('HTTP selection keeps strict millimetres and duplicate checks', () => {
    const c={...command(),bars:[{barId:'10000000-0000-4000-8000-000000000001',expectedVersion:1,quantityMm:.001}]};
    expect(materialBarMovementCommandSchema.safeParse(c).success).toBe(true);
    for (const value of ['1',-1,NaN,.0001]) expect(materialBarMovementCommandSchema.safeParse({...c,bars:[{...c.bars[0],quantityMm:value}]}).success).toBe(false);
    expect(materialBarMovementCommandSchema.safeParse({...c,bars:[...c.bars,...c.bars]}).success).toBe(false);
  });
});
