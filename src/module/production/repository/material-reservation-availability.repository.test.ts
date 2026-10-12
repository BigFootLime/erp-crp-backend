import {beforeEach, expect, it, vi} from 'vitest';
import type {readMaterialTx} from './of-material.repository';
const quality=vi.hoisted(()=>vi.fn());
vi.mock('../../qualite/repository/quality-operational-gate.repository',()=>({readOperationalLotQualityEligibility:quality}));
import {readMaterialReservationAvailabilityTx} from './material-reservation-availability.repository';
type Material=Awaited<ReturnType<typeof readMaterialTx>>;
const tx={query:vi.fn()};
function fixture(){return {needs:[{key:'n',articleId:'a',unit:'u',requirements:{ownerClientId:null,grade:null,condition:null,dimensions:{},certificates:[],manualChecks:[]},
  reservations:[{id:'r',lot_id:'l',stock_batch_id:'b',status:'ACTIVE',unexpired:true,qty_reserved:30,qty_consumed:5}],
  candidates:[{lot:{id:'l',batchId:'b',articleId:'a',unit:'u',quality:'LIBERE',ownerClientId:null,dimensions:{},certificates:[],manualVerified:false}}]}]} as unknown as Material;}
beforeEach(()=>{vi.clearAllMocks();quality.mockResolvedValue({eligibility:{blocks:[]}});});
it('uses remaining reservations once, independently of their free stock quantity',async()=>{
  const result=await readMaterialReservationAvailabilityTx(tx,fixture());
  expect(result.get('n')!.usable).toBe(25);expect(result.get('n')!.reservations.get('r')).toBe(25);
  expect(quality).toHaveBeenCalledWith({client:tx,lotId:'l',qty:0,unit:'u',purpose:'RESERVE'});
});
it.each([{quality:'QUARANTAINE'},{unit:'kg'},{ownerClientId:'another-client'},{articleId:'another-article'}])('rejects a reservation whose lot is incompatible: %j',async change=>{
  const m=fixture();Object.assign(m.needs[0].candidates[0].lot,change);
  const result=await readMaterialReservationAvailabilityTx(tx,m);
  expect(result.get('n')!.usable).toBe(0);expect(result.get('n')!.blockers.length).toBeGreaterThan(0);
});
it('rechecks a new quality hold even on a nominally released lot',async()=>{
  quality.mockResolvedValue({eligibility:{blocks:[{message:'Contrôle requis'}]}});
  expect((await readMaterialReservationAvailabilityTx(tx,fixture())).get('n')).toMatchObject({usable:0,blockers:['Contrôle requis']});
});
it('does not reuse expired, cancelled or already consumed reservations',async()=>{
  for(const change of [{status:'CANCELLED'},{status:'CONSUMED'},{unexpired:false},{qty_consumed:30}]){
    const m=fixture();Object.assign(m.needs[0].reservations[0],change);
    expect((await readMaterialReservationAvailabilityTx(tx,m)).get('n')!.usable).toBe(0);
  }
  expect(quality).not.toHaveBeenCalled();
});
it('treats a disappeared stock batch as unavailable',async()=>{
  const m=fixture();m.needs[0].candidates=[];
  expect((await readMaterialReservationAvailabilityTx(tx,m)).get('n')!.usable).toBe(0);
});

it('blocks the 20-piece gate for 2000 + 210 mm, but keeps raw holds available to measured debit',async()=>{
  const m=fixture(),need=m.needs[0];
  need.debitRule={form:'BAR',stockUnit:'mm',unitsPerBlank:110,kerfPerBlank:.5,yieldValidated:true};
  need.reservations=[{...need.reservations[0],qty_reserved:2000,qty_consumed:0},
    {...need.reservations[0],id:'r2',stock_batch_id:'b2',qty_reserved:210,qty_consumed:0}];
  need.candidates.push({...need.candidates[0],lot:{...need.candidates[0].lot,batchId:'b2'}});
  const result=(await readMaterialReservationAvailabilityTx(tx,m)).get('n')!;
  expect(result.usable).toBe(2099.5);
  expect(result.reservations.get('r2')).toBe(210);
  need.reservations.push({...need.reservations[1],id:'topup',qty_reserved:11});
  expect((await readMaterialReservationAvailabilityTx(tx,m)).get('n')!.usable).toBe(2210);
});
