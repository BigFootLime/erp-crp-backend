import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),command:vi.fn(),readiness:vi.fn(),consume:vi.fn(),quality:vi.fn(),declare:vi.fn()}));
vi.mock('./of-material.repository',()=>({materialCommand:m.command,readMaterialTx:m.read}));
vi.mock('./operation-readiness.repository',()=>({readOperationReadinessTx:m.readiness}));
vi.mock('../../stock/repository/partial-reservation-consumption.repository',()=>({consumeMaterialReservationTx:m.consume}));
vi.mock('../../qualite/repository/quality-operational-gate.repository',()=>({assertOperationalLotQualityEligibility:m.quality}));
vi.mock('./production-execution.repository',()=>({repoDeclareQuantity:m.declare}));
vi.mock('../../../config/database',()=>({default:{connect:vi.fn()}}));
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {debitOfMaterial} from './of-material-debit.repository';
import type {MaterialDebit} from '../validators/of-material.validators';
const requirements={grade:null,condition:null,ownerClientId:null,dimensions:{},certificates:[],manualChecks:[]};
const lot={id:'lot',batchId:'batch',articleId:'article',quality:'LIBERE',unit:'u',...requirements,manualVerified:true};
const body={expectedVersion:'v1',idempotencyKey:'command',operationId:'cut',good:18,scrap:2,scrapReason:'REGLAGE',note:'Débit de recette documenté',sources:[{reservationId:'reservation',quantity:20,expectedVersion:4}],successorOperationId:'turn'} satisfies MaterialDebit;
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
});
describe('débit matière, déclaration et transfert',()=>{
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
    expect(tx.query.mock.calls.some(([sql])=>sql==='COMMIT'||sql.includes('INSERT INTO public.production_material_debits'))).toBe(false);
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
});
