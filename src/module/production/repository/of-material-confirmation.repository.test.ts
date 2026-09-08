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
function coverage(){return {version:'v1',number:'OF-TEST',previousNeeds:[] as unknown[],needs:[need()],operations:[{id:'cut',start:'2026-09-18T08:00:00Z'}]};}
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
  it('reserves 60, assigns an existing 25 and buys only 15 for a need of 100',async()=>{
    await confirmOfMaterial(19,body,audit,true);
    expect(m.reserve).toHaveBeenCalledWith(expect.objectContaining({qty:60}),audit,expect.any(String),tx,'need');
    expect(m.allocate).toHaveBeenCalledWith(tx,{lineId:'line',needId:'need',sourceRef:'source',ofId:19,quantity:25});
    expect(m.draft).toHaveBeenCalledWith(tx,[expect.objectContaining({quantity:15,assigned:15,requirements:['diametre_mm : 25 mm minimum']})],audit);
    expect(tx.query).toHaveBeenCalledWith('COMMIT');
  });
  it('keeps already expected stock when calculating the new purchase',async()=>{
    current.needs[0].expected=25;
    await confirmOfMaterial(19,{...body,futureSelections:[]},audit,true);
    expect(m.draft).toHaveBeenCalledWith(tx,[expect.objectContaining({quantity:15})],audit);
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
