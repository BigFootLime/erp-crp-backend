import { describe, expect, it } from 'vitest';
import { validateMaterialBarCount } from './material-bar-count.repository';
import { materialBarInventoryCommand } from '../validators/material-bars.validators';
import { upsertInventoryLineSchema } from '../validators/stock.validators';
import type { MaterialBarInventory } from './material-bar-inventory.repository';

const id='11111111-1111-4111-8111-111111111111',batch='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
function fixture() {
  const current:MaterialBarInventory={batch:{id:batch,levelId:'level',lotId:'lot',lotCode:'lot',articleId:'article',articleCode:'article',designation:'bar',unit:'mm',physicalMm:3000,reservedMm:0,movementCount:'1'},
    bars:[{id,batchId:batch,lengthMm:3000,initialLengthMm:3000,version:1,createdAt:'now'}],holds:[],reservations:[],revision:1,version:'a'.repeat(64),status:'CONFIRMED',warning:null};
  const body=materialBarInventoryCommand.parse({expectedVersion:current.version,idempotencyKey:other,reason:'Comptage atelier',bars:[{id,lengthMm:3000,allocations:[]}]});
  return {current,body};
}
describe('physical bar count',()=>{
  it('does not mutate the canonical snapshot when projecting a lower count',()=>{
    const {current,body}=fixture();body.bars[0].lengthMm=2800;
    expect(validateMaterialBarCount(current,body,2800).geometryChanged).toBe(true);
    expect(current.batch.physicalMm).toBe(3000);expect(current.bars[0].lengthMm).toBe(3000);
  });
  it('distinguishes unchanged geometry from an equal-total replacement',()=>{
    const {current,body}=fixture();expect(validateMaterialBarCount(current,body,3000).geometryChanged).toBe(false);
    body.bars=[{id:other,lengthMm:3000,allocations:[]}];expect(validateMaterialBarCount(current,body,3000).geometryChanged).toBe(true);
  });
  it('flags equal-total split bars for a required second count',()=>{
    const {current,body}=fixture();body.bars=[{id,lengthMm:1500,allocations:[]},{id:other,lengthMm:1500,allocations:[]}];
    expect(validateMaterialBarCount(current,body,3000).geometryChanged).toBe(true);
  });
  it('accepts measured empty stock only without remaining reservations',()=>{
    const {current,body}=fixture();body.bars=[];expect(validateMaterialBarCount(current,body,0).countedQty).toBe(0);
    current.batch.reservedMm=100;current.reservations=[{id:other,batchId:batch,remainingMm:100,version:1,ofId:1,ofNumber:'OF-TEST'}];
    current.holds=[{barId:id,reservationId:other,remainingMm:100}];expect(()=>validateMaterialBarCount(current,body,0)).toThrow();
  });
  it('requires the measurements to cover the exact total',()=>{
    const {current,body}=fixture();expect(()=>validateMaterialBarCount(current,body,2999)).toThrow(/total/);
  });
  it.each([Infinity,NaN,-1,0.0001,1e9+1])('rejects invalid count %s',quantity=>{
    const {current,body}=fixture();expect(()=>validateMaterialBarCount(current,body,quantity)).toThrow(/décimales/);
  });
  it('does not lengthen an existing identity beyond its original bar',()=>{
    const {current,body}=fixture();body.bars[0].lengthMm=3100;expect(()=>validateMaterialBarCount(current,body,3100)).toThrow(/initiale/);
  });
  it('permits a measured extra bar with a new identity',()=>{
    const {current,body}=fixture();body.bars.push({id:other,lengthMm:500,allocations:[]});expect(validateMaterialBarCount(current,body,3500).geometryChanged).toBe(true);
  });
  it('requires every active OF reservation to remain allocated',()=>{
    const {current,body}=fixture();current.batch.reservedMm=100;current.reservations=[{id:other,batchId:batch,remainingMm:100,version:1,ofId:1,ofNumber:'OF-TEST'}];
    current.holds=[{barId:id,reservationId:other,remainingMm:100}];expect(()=>validateMaterialBarCount(current,body,3000)).toThrow();
    body.bars[0].allocations=[{reservationId:other,quantityMm:100}];expect(validateMaterialBarCount(current,body,3000).geometryChanged).toBe(false);
  });
  it('rejects an old stock/reservation version',()=>{
    const {current,body}=fixture();current.version='b'.repeat(64);expect(()=>validateMaterialBarCount(current,body,3000)).toThrow(/changé/);
  });
  it('accepts the canonical strict count payload and rejects duplicated bar ids',()=>{
    const {body}=fixture(),request={body:{article_id:id,magasin_id:batch,emplacement_id:1,counted_qty:3000,expected_session_version:1,material_bars:body}};
    expect(upsertInventoryLineSchema.safeParse(request).success).toBe(true);
    body.bars.push(body.bars[0]);expect(upsertInventoryLineSchema.safeParse(request).success).toBe(false);
  });
});
