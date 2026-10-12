import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),command:vi.fn(),readiness:vi.fn(),consume:vi.fn(),quality:vi.fn(),declare:vi.fn(),remnant:vi.fn(),barPlan:vi.fn(),barApply:vi.fn()}));
vi.mock('./of-material.repository',()=>({materialCommand:m.command,readMaterialTx:m.read}));
vi.mock('./operation-readiness.repository',()=>({readOperationReadinessTx:m.readiness}));
vi.mock('../../stock/repository/partial-reservation-consumption.repository',()=>({consumeMaterialReservationTx:m.consume}));
vi.mock('../../qualite/repository/quality-operational-gate.repository',()=>({assertOperationalLotQualityEligibility:m.quality}));
vi.mock('./production-execution.repository',()=>({repoDeclareQuantity:m.declare}));
vi.mock('../../stock/repository/material-remnant.repository',()=>({createMaterialRemnantTx:m.remnant}));
vi.mock('../../stock/repository/material-bar-debit.repository',()=>({prepareMaterialBarDebitTx:m.barPlan,applyMaterialBarDebitTx:m.barApply}));
vi.mock('../../../config/database',()=>({default:{connect:vi.fn()}}));
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {debitOfMaterial} from './of-material-debit.repository';
import type {MaterialDebit} from '../validators/of-material.validators';
const requirements={grade:null,condition:null,ownerClientId:null,dimensions:{},certificates:[],manualChecks:[]};
const lot={id:'lot',batchId:'batch',articleId:'article',quality:'LIBERE',unit:'u',...requirements,manualVerified:true};
const body={expectedVersion:'v1',idempotencyKey:'command',operationId:'cut',good:18,scrap:2,scrapReason:'REGLAGE',note:'Débit de recette documenté',remnants:[],sources:[{reservationId:'reservation',quantity:20,expectedVersion:4}],successorOperationId:'turn'} satisfies MaterialDebit;
const audit={user_id:1} as never;
function coverage(){return {version:'v1',technicalVersion:'technical',operations:[{id:'cut',phase:10},{id:'turn',phase:20}],needs:[{id:'need',key:'purchase',operationId:'cut',articleId:'article',unit:'u',designation:'Matière',requirements,blockers:[],debitRule:{form:'UNIT',stockUnit:'u',unitsPerBlank:1,kerfPerBlank:0,yieldValidated:true},reservations:[{id:'reservation',stock_batch_id:'batch'}],candidates:[{lot}]}]};}
let current:ReturnType<typeof coverage>;
let tx:{query:ReturnType<typeof vi.fn>;release:ReturnType<typeof vi.fn>};
beforeEach(()=>{
  vi.resetAllMocks();current=coverage();tx={query:vi.fn().mockResolvedValue({rows:[]}),release:vi.fn()};
  m.command.mockImplementation((_of,_type,_body,_audit,work)=>withRealtimeOutboxTransaction(tx as never,client=>work(client,current)));
  m.read.mockImplementation(async()=>current);m.quality.mockResolvedValue({});
  m.readiness.mockResolvedValue({operations:[{id:'cut',status:'RUNNING',canStart:true,availableQuantity:60}]});
  m.consume.mockResolvedValue({reservationId:'reservation',stockMovementId:'movement',quantity:20,remaining:40,status:'ACTIVE'});
  m.declare.mockResolvedValue({id:'declaration'});
  m.barPlan.mockResolvedValue({changes:[],batchIds:[],consumptions:new Map()});m.barApply.mockResolvedValue(undefined);
  tx.query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT id::text,phase')?current.operations:
    sql.startsWith('SELECT q.qty_good')?[{good:18,released:0,edge_released:0}]:sql.includes('INSERT INTO public.production_transfer_batches')?[{id:'transfer'}]:[]}));
});
describe('débit matière, déclaration et transfert',()=>{
  it('requires physical bar selection for a prepared BAR need before consuming stock',async()=>{
    Object.assign(current.needs[0],{unit:'mm',barInventories:{},debitRule:{form:'BAR',stockUnit:'mm',unitsPerBlank:110,kerfPerBlank:.5,yieldValidated:true}});
    current.needs[0].candidates[0].lot={...lot,unit:'mm'};
    m.readiness.mockResolvedValue({operations:[{id:'cut',status:'RUNNING',canStart:true,availableQuantity:60,remainingQuantity:60}]});
    await expect(debitOfMaterial(19,body,audit)).rejects.toMatchObject({code:'MATERIAL_BAR_DEBIT_REQUIRED'});
    expect(m.consume).not.toHaveBeenCalled();expect(m.declare).not.toHaveBeenCalled();
  });
  it('joins physical closure, canonical consumption and observed yield in one transaction',async()=>{
    Object.assign(current.needs[0],{unit:'mm',barInventories:{batch:{}},debitRule:{form:'BAR',stockUnit:'mm',unitsPerBlank:110,kerfPerBlank:.5,yieldValidated:true}});
    current.needs[0].candidates[0].lot={...lot,unit:'mm'};
    m.readiness.mockResolvedValue({operations:[{id:'cut',status:'RUNNING',canStart:true,availableQuantity:60,remainingQuantity:60}]});
    const auth={reservationId:'reservation',quantityMm:500,extraMm:279,barIds:['bar']},plan={changes:[],batchIds:['batch'],consumptions:new Map([['reservation',auth]])};
    m.barPlan.mockResolvedValue(plan);m.consume.mockResolvedValue({reservationId:'reservation',stockMovementId:'movement',quantity:500,extendedQuantity:279});
    await debitOfMaterial(19,{...body,good:2,scrap:0,scrapReason:null,successorOperationId:null,varianceReason:'Reliquat écarté après mesure au poste.',sources:[
      {reservationId:'reservation',quantity:221,expectedVersion:4,bars:[{barId:'bar',quantity:221,expectedVersion:7,
        barClosure:{discardedQuantity:279,acknowledgedLargeRemainder:true}}]}]},audit);
    expect(m.consume).toHaveBeenCalledWith(tx,expect.objectContaining({quantity:500,barDiscardAllowance:279,physicalBarDebit:auth}),audit);
    expect(m.barApply).toHaveBeenCalledWith(tx,plan,expect.objectContaining({consumed:[expect.objectContaining({quantity:500})]}));
    expect(m.barApply.mock.invocationCallOrder[0]).toBeLessThan(m.declare.mock.invocationCallOrder[0]);
    const proof=tx.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO public.production_material_debit_sources'))![1];
    expect(proof.slice(4)).toEqual([221,500,221,279,true,279,2,0]);expect(tx.query).toHaveBeenCalledWith('COMMIT');
  });
  it('rolls back canonical stock if the physical update fails and does not declare WIP',async()=>{
    m.barApply.mockRejectedValue(new Error('bar changed'));
    await expect(debitOfMaterial(19,body,audit)).rejects.toThrow('bar changed');
    expect(m.consume).toHaveBeenCalled();expect(m.declare).not.toHaveBeenCalled();expect(tx.query).toHaveBeenCalledWith('ROLLBACK');
  });
  it('debits the receipt and top-up holds of one batch with one two-blank declaration',async()=>{
    const need=current.needs[0];
    need.unit='mm';need.debitRule={form:'BAR',stockUnit:'mm',unitsPerBlank:110,kerfPerBlank:.5,yieldValidated:true};
    need.candidates[0].lot={...need.candidates[0].lot,unit:'mm'};
    need.reservations.push({id:'topup',stock_batch_id:'batch'});
    m.readiness.mockResolvedValue({operations:[{id:'cut',status:'RUNNING',canStart:true,availableQuantity:20,remainingQuantity:20}]});
    m.consume.mockImplementation(async(_tx,source)=>({reservationId:source.reservationId,stockMovementId:`movement-${source.reservationId}`,quantity:source.quantity,remaining:0,status:'CONSUMED'}));
    await debitOfMaterial(19,{...body,good:2,scrap:0,scrapReason:null,successorOperationId:null,sources:[
      {reservationId:'reservation',quantity:210,expectedVersion:4,yield:{good:2,scrap:0}},
      {reservationId:'topup',quantity:11,expectedVersion:1,yield:{good:0,scrap:0}},
    ]},audit);
    expect(m.consume).toHaveBeenCalledTimes(2);
    expect(m.declare).toHaveBeenCalledTimes(1);
    expect(m.declare).toHaveBeenCalledWith(expect.objectContaining({body:expect.objectContaining({qty_good:2,qty_scrap:0})}));
    const sources=tx.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO public.production_material_debit_sources'));
    expect(sources.map(([,params])=>({actual:params[5],good:params[10]}))).toEqual([{actual:210,good:2},{actual:11,good:0}]);
    expect(tx.query).toHaveBeenCalledWith('COMMIT');
  });
  it('consomme 20, déclare 18 bons et 2 rebuts, transfère 18 dans la même transaction',async()=>{
    const result=await debitOfMaterial(19,body,audit);
    expect(result).toMatchObject({declarationId:'declaration',consumed:[{quantity:20,remaining:40}]});
    expect(m.consume).toHaveBeenCalledWith(tx,expect.objectContaining({quantity:20,ofId:19,operationId:'cut'}),audit);
    expect(m.declare).toHaveBeenCalledWith(expect.objectContaining({transactionClient:tx,body:expect.objectContaining({qty_good:18,qty_scrap:2,qty_pending_control:0,qty_rework:0})}));
    const transfer=tx.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO public.production_transfer_batches'));
    expect(transfer?.[1]).toEqual(['cut','turn',18,result.debitId,1]);
    expect(tx.query.mock.calls.filter(([sql])=>sql==='COMMIT')).toHaveLength(1);
    expect(tx.release).toHaveBeenCalledTimes(1);
  });
  it('annule la sortie lorsque la déclaration échoue',async()=>{
    m.declare.mockRejectedValue(new Error('déclaration refusée'));
    await expect(debitOfMaterial(19,body,audit)).rejects.toThrow('déclaration refusée');
    expect(m.consume).toHaveBeenCalled();expect(tx.query).toHaveBeenCalledWith('ROLLBACK');
    expect(tx.query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
    expect(m.remnant).not.toHaveBeenCalled();
  });
  it('annule aussi la déclaration et le stock si le successeur est invalide',async()=>{
    await expect(debitOfMaterial(19,{...body,successorOperationId:'foreign'},audit)).rejects.toMatchObject({code:'MATERIAL_TRANSFER_SUCCESSOR_INVALID'});
    expect(m.declare).toHaveBeenCalled();expect(tx.query).toHaveBeenCalledWith('ROLLBACK');
    expect(tx.query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
  });
  it('refuse 61 bruts pour 60 disponibles avant la sortie',async()=>{
    await expect(debitOfMaterial(19,{...body,good:61,scrap:0},audit)).rejects.toMatchObject({code:'MATERIAL_DEBIT_QUANTITY_EXCEEDED'});
    expect(m.consume).not.toHaveBeenCalled();
  });
  it('refuse une conversion inexacte, sans consommer de réserve',async()=>{
    await expect(debitOfMaterial(19,{...body,sources:[{...body.sources[0],quantity:19}]},audit)).rejects.toMatchObject({code:'MATERIAL_DEBIT_CONVERSION_MISMATCH'});
    expect(m.consume).not.toHaveBeenCalled();
  });
  it('refuse le lot redevenu non conforme et conserve toutes les réservations',async()=>{
    m.quality.mockRejectedValue(new Error('lot bloqué'));
    await expect(debitOfMaterial(19,body,audit)).rejects.toThrow('lot bloqué');expect(m.consume).not.toHaveBeenCalled();
  });
  it('refuse les opérations non démarrées sans créer de pointage',async()=>{
    m.readiness.mockResolvedValue({operations:[{id:'cut',status:'READY',canStart:true,availableQuantity:60}]});
    await expect(debitOfMaterial(19,body,audit)).rejects.toMatchObject({code:'MATERIAL_DEBIT_OPERATION_NOT_STARTED'});expect(m.consume).not.toHaveBeenCalled();
  });
  it('ne crée pas de transfert quand les bruts sont conservés au poste',async()=>{
    await debitOfMaterial(19,{...body,successorOperationId:null},audit);
    expect(tx.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO public.production_transfer_batches'))).toBe(false);
  });
  it('rolls back consumption, quantity and proof if creating the reusable remnant fails',async()=>{
    current.needs[0].debitRule.form='BAR';m.remnant.mockRejectedValue(new Error('remnant stock failed'));
    await expect(debitOfMaterial(19,{...body,varianceReason:'Barre entière sortie avec une chute réutilisable.',sources:[{...body.sources[0],quantity:25}],remnants:[{reservationId:'reservation',quantity:5,dimensions:{longueur_mm:500}}]},audit)).rejects.toThrow('remnant stock failed');
    expect(m.declare).toHaveBeenCalled();expect(tx.query).toHaveBeenCalledWith('ROLLBACK');expect(tx.query).not.toHaveBeenCalledWith('COMMIT');
  });
});
