import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),command:vi.fn(),reserve:vi.fn(),draft:vi.fn(),lockFuture:vi.fn(),allocate:vi.fn()}));
vi.mock('./of-material.repository',()=>({materialCommand:m.command,readMaterialTx:m.read}));
vi.mock('../../stock/repository/stock-reservation.repository',()=>({repoCreateStockReservation:m.reserve}));
vi.mock('../../commande-fournisseur/repository/commande-fournisseur.repository',()=>({createMaterialDraftsTx:m.draft}));
vi.mock('./material-future-supply.repository',()=>({lockFutureMaterialSupplyTx:m.lockFuture,allocateFutureMaterialSupplyTx:m.allocate}));
vi.mock('../../../config/database',()=>({default:{connect:vi.fn()}}));
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {confirmOfMaterial} from './of-material-confirmation.repository';
import type {MaterialConfirmation} from '../validators/of-material.validators';
const requirements={grade:null,condition:null,ownerClientId:null,dimensions:{diametre_mm:25},certificates:[],manualChecks:[]};
function need(){return {id:'need',key:'source',articleId:'article',operationId:'cut',operationLabel:'Découpe',designation:'Matière',unit:'u',required:100,reserved:0,consumed:0,expected:0,receivedBlocked:0,
  requirements,blockers:[],supplierId:'supplier',price:2,currency:'EUR',destinationId:null,catalog:null,supplyMode:'PURCHASE',
  candidates:[{available:60,lot:{id:'lot',batchId:'batch',articleId:'article',unit:'u',quality:'LIBERE',ownerClientId:null,dimensions:{diametre_mm:25},certificates:[],magasinId:'store',emplacementId:1}}],
  futureSupplies:[{id:'line',available:25,reasons:[] as string[]}]};}
function coverage(){return {version:'v1',number:'OF-TEST',previousNeeds:[] as unknown[],purchasePreparations:[],needs:[need()],operations:[{id:'cut',start:'2026-09-18T08:00:00Z'}]};}
const body:MaterialConfirmation={expectedVersion:'v1',idempotencyKey:'command',selections:[{needKey:'source',batchId:'batch',quantity:60}],futureSelections:[{needKey:'source',lineId:'line',quantity:25,requirementsReviewed:true}]};
const audit={user_id:1} as never;
let current:ReturnType<typeof coverage>;
let tx:{query:ReturnType<typeof vi.fn>;release:ReturnType<typeof vi.fn>};
beforeEach(()=>{
  vi.resetAllMocks();current=coverage();tx={query:vi.fn().mockResolvedValue({rows:[]}),release:vi.fn()};
  m.command.mockImplementation((_of,_type,_body,_audit,work)=>withRealtimeOutboxTransaction(tx as never,client=>work(client,current)));
  m.read.mockImplementation(async()=>current);m.reserve.mockResolvedValue({reservation:{id:'reservation'}});m.draft.mockResolvedValue([{id:'draft',code:'BCF-TEST'}]);
});
describe('physical and future material confirmation',()=>{
  it('passes the physical top-up to the canonical reservation without another purchase',async()=>{
    Object.assign(current.needs[0],{required:221,reserved:210,unit:'mm',futureSupplies:[],
      debitRule:{form:'BAR',stockUnit:'mm',unitsPerBlank:110,kerfPerBlank:.5,yieldValidated:true},
      reservations:[{id:'receipt',stock_batch_id:'batch',status:'ACTIVE',unexpired:true,qty_reserved:210,qty_consumed:0}],
      barInventories:{batch:{status:'CONFIRMED',version:'bars',warning:null,
        bars:[{id:'bar',batchId:'batch',lengthMm:1000,version:7}],holds:[{barId:'bar',reservationId:'receipt',remainingMm:210}]}}});
    current.needs[0].candidates[0].available=790;current.needs[0].candidates[0].lot.unit='mm';
    await confirmOfMaterial(19,{...body,selections:[{needKey:'source',batchId:'batch',quantity:11}],futureSelections:[]},audit,true);
    expect(m.reserve).toHaveBeenCalledWith(expect.objectContaining({qty:11,
      barAllocations:[{barId:'bar',quantityMm:11,expectedVersion:7}]}),audit,expect.any(String),tx,'need');
    expect(m.draft).toHaveBeenCalledWith(tx,[],audit);
  });
  it('does not combine separate remnants when confirming a batch selection',async()=>{
    Object.assign(current.needs[0],{required:331.5,reserved:0,unit:'mm',futureSupplies:[],reservations:[],
      debitRule:{form:'BAR',stockUnit:'mm',unitsPerBlank:110,kerfPerBlank:.5,yieldValidated:true},
      barInventories:{batch:{status:'CONFIRMED',version:'bars',warning:null,
        bars:[{id:'bar1',batchId:'batch',lengthMm:200,version:1},{id:'bar2',batchId:'batch',lengthMm:200,version:1}],holds:[]}}});
    current.needs[0].candidates[0].available=400;current.needs[0].candidates[0].lot.unit='mm';
    await expect(confirmOfMaterial(19,{...body,selections:[{needKey:'source',batchId:'batch',quantity:331.5}],futureSelections:[]},audit,true))
      .rejects.toMatchObject({code:'MATERIAL_FRAGMENTED_SELECTION'});
    expect(m.reserve).not.toHaveBeenCalled();expect(m.draft).not.toHaveBeenCalled();
  });
  it('waits for geometry review before automatically buying apparently missing material',async()=>{
    Object.assign(current.needs[0],{blockers:['Vérifiez les barres du stock existant avant de préparer un achat.']});
    await expect(confirmOfMaterial(19,{...body,selections:[],futureSelections:[]},audit,true)).rejects.toMatchObject({code:'MATERIAL_PREPARATION_REQUIRED'});
    expect(m.reserve).not.toHaveBeenCalled();expect(m.draft).not.toHaveBeenCalled();
  });
  it('refreshes a shared bar version between two needs inside the same confirmation',async()=>{
    const geometry={status:'CONFIRMED',version:'bars',warning:null,bars:[{id:'bar',batchId:'batch',lengthMm:400,version:1}],holds:[] as Array<{barId:string;reservationId:string;remainingMm:number}>};
    const first=current.needs[0],second=need();second.id='need2';second.key='source2';current.needs.push(second);
    for(const n of current.needs){
      Object.assign(n,{required:110.5,reserved:0,unit:'mm',futureSupplies:[],reservations:[],barInventories:{batch:geometry},
        debitRule:{form:'BAR',stockUnit:'mm',unitsPerBlank:110,kerfPerBlank:.5,yieldValidated:true}});
      n.candidates[0].available=400;n.candidates[0].lot.unit='mm';
    }
    m.reserve.mockImplementation(async()=>{
      const id=`reservation-${m.reserve.mock.calls.length}`;
      geometry.bars[0].version++;geometry.holds.push({barId:'bar',reservationId:id,remainingMm:110.5});
      return {reservation:{id}};
    });
    await confirmOfMaterial(19,{...body,selections:[{needKey:first.key,batchId:'batch',quantity:110.5},
      {needKey:second.key,batchId:'batch',quantity:110.5}],futureSelections:[]},audit,true);
    expect(m.reserve.mock.calls.map(([input])=>input.barAllocations[0].expectedVersion)).toEqual([1,2]);
    expect(m.draft).toHaveBeenCalledWith(tx,[],audit);
  });
  it('completes 2000 + 210 mm with an 11 mm hold, preserving receipt reservations and buying nothing',async()=>{
    Object.assign(current.needs[0],{required:2210,reserved:2210,unit:'mm',futureSupplies:[],
      debitRule:{form:'BAR',stockUnit:'mm',unitsPerBlank:110,kerfPerBlank:.5,yieldValidated:true},
      reservations:[{id:'receipt1',stock_batch_id:'batch1',status:'ACTIVE',unexpired:true,qty_reserved:2000,qty_consumed:0},
        {id:'receipt2',stock_batch_id:'batch',status:'ACTIVE',unexpired:true,qty_reserved:210,qty_consumed:0}]});
    current.needs[0].candidates[0].available=790;current.needs[0].candidates[0].lot.unit='mm';
    await confirmOfMaterial(19,{...body,selections:[{needKey:'source',batchId:'batch',quantity:11}],futureSelections:[]},audit,true);
    expect(m.reserve).toHaveBeenCalledWith(expect.objectContaining({qty:11}),audit,expect.any(String),tx,'need');
    expect(m.draft).toHaveBeenCalledWith(tx,[],audit);
    expect(tx.query).toHaveBeenCalledWith('COMMIT');
  });
  it('rejects a rounded-looking length that cannot complete a whole blank',async()=>{
    Object.assign(current.needs[0],{required:2210,reserved:0,unit:'mm',futureSupplies:[],reservations:[],
      debitRule:{form:'BAR',stockUnit:'mm',unitsPerBlank:110,kerfPerBlank:.5,yieldValidated:true}});
    current.needs[0].candidates[0].available=2000;current.needs[0].candidates[0].lot.unit='mm';
    await expect(confirmOfMaterial(19,{...body,selections:[{needKey:'source',batchId:'batch',quantity:2000}],futureSelections:[]},audit,true)).rejects.toMatchObject({code:'MATERIAL_FRAGMENTED_SELECTION'});
    expect(m.reserve).not.toHaveBeenCalled();expect(m.draft).not.toHaveBeenCalled();
  });
  it('reserves 60, assigns an existing 25 and buys only 15 for a need of 100',async()=>{
    await confirmOfMaterial(19,body,audit,true);
    expect(m.reserve).toHaveBeenCalledWith(expect.objectContaining({qty:60}),audit,expect.any(String),tx,'need');
    expect(m.allocate).toHaveBeenCalledWith(tx,{lineId:'line',needId:'need',sourceRef:'source',ofId:19,quantity:25});
    expect(m.draft).toHaveBeenCalledWith(tx,[expect.objectContaining({quantity:15,assigned:15,requirements:['diametre_mm : 25 mm minimum']})],audit);
    expect(tx.query).toHaveBeenCalledWith('COMMIT');
  });
  it('keeps already expected stock when calculating the new purchase',async()=>{
    current.needs[0].expected=25;
    await confirmOfMaterial(19,{...body,futureSelections:[],existingPurchasesReviewed:true},audit,true);
    expect(m.draft).toHaveBeenCalledWith(tx,[expect.objectContaining({quantity:15})],audit);
  });
  it('requires explicit review before ignoring an available existing purchase',async()=>{
    current.needs[0].expected=25;
    await expect(confirmOfMaterial(19,{...body,futureSelections:[]},audit,true)).rejects.toMatchObject({code:'MATERIAL_EXISTING_PURCHASE_REVIEW'});
    expect(m.draft).not.toHaveBeenCalled();expect(tx.query).toHaveBeenCalledWith('ROLLBACK');
  });
  it('does not buy or reserve again once all quantities are covered',async()=>{
    current.needs[0].reserved=60;current.needs[0].expected=40;
    await confirmOfMaterial(19,{...body,selections:[],futureSelections:[]},audit,true);
    expect(m.reserve).not.toHaveBeenCalled();expect(m.allocate).not.toHaveBeenCalled();expect(m.draft).toHaveBeenCalledWith(tx,[],audit);
  });
  it('rejects a future source that no longer meets the need',async()=>{
    current.needs[0].futureSupplies[0].reasons=['Autre propriétaire'];
    await expect(confirmOfMaterial(19,body,audit,true)).rejects.toMatchObject({code:'MATERIAL_FUTURE_SUPPLY_CHANGED'});
    expect(m.reserve).not.toHaveBeenCalled();expect(m.allocate).not.toHaveBeenCalled();
  });
  it('never assigns one future pool twice to two needs',async()=>{
    const second=need();second.id='need2';second.key='source2';current.needs.push(second);
    await expect(confirmOfMaterial(19,{...body,futureSelections:[...body.futureSelections,{needKey:'source2',lineId:'line',quantity:1,requirementsReviewed:true}]},audit,true)).rejects.toMatchObject({code:'MATERIAL_FUTURE_SUPPLY_CHANGED'});
    expect(tx.query).toHaveBeenCalledWith('ROLLBACK');expect(tx.query).not.toHaveBeenCalledWith('COMMIT');
  });
  it('rejects combined physical and future overcoverage',async()=>{
    await expect(confirmOfMaterial(19,{...body,futureSelections:[{...body.futureSelections[0],quantity:41}]},audit,true)).rejects.toMatchObject({code:'MATERIAL_OVER_COVERAGE'});
    expect(m.reserve).not.toHaveBeenCalled();expect(m.allocate).not.toHaveBeenCalled();
  });
  it('rolls back the future allocation if the physical reservation fails',async()=>{
    m.reserve.mockRejectedValue(new Error('stock modified'));
    await expect(confirmOfMaterial(19,body,audit,true)).rejects.toThrow('stock modified');
    expect(m.allocate).toHaveBeenCalled();expect(tx.query).toHaveBeenCalledWith('ROLLBACK');expect(m.draft).not.toHaveBeenCalled();
  });
  it('requires a refreshed preview after locking the purchase',async()=>{
    m.read.mockResolvedValue({...current,version:'v2'});
    await expect(confirmOfMaterial(19,body,audit,true)).rejects.toMatchObject({code:'MATERIAL_COVERAGE_CHANGED'});
    expect(m.allocate).not.toHaveBeenCalled();
  });
  it('allows stock allocation but leaves new buying to an authorized buyer',async()=>{
    const result=await confirmOfMaterial(19,body,audit,false);
    expect(m.allocate).toHaveBeenCalled();expect(m.draft).toHaveBeenCalledWith(tx,[],audit);expect(result.pending[0].message).toMatch(/habilité/);
  });
});
