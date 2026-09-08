import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),command:vi.fn(),receive:vi.fn()}));
vi.mock('./of-material.repository',()=>({materialCommand:m.command,readMaterialTx:m.read}));
vi.mock('../../receptions/repository/receptions.repository',()=>({createCustomerMaterialReceiptTx:m.receive}));
vi.mock('../../../config/database',()=>({default:{connect:vi.fn()}}));
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {commandCustomerMaterial} from './customer-material.repository';
import type {CustomerMaterialCommand} from '../validators/customer-material.validators';
const requirements={ownerClientId:'client',grade:'6082',condition:'T651',dimensions:{},certificates:[],manualChecks:[]};
function coverage(){return {version:'v1',clientId:'client',needs:[{id:'need',key:'source',articleId:'article',designation:'Matière',unit:'u',requirements:{...requirements},blockers:[],supplyMode:'CUSTOMER',required:100,reserved:0,consumed:0,expected:40,receivedBlocked:0}],
  customerCalls:[{id:'call',need_id:'need',client_id:'client',unit:'u',status:'SENT',quantity:40,received:10}]};}
const body:CustomerMaterialCommand={action:'RECEIVE',expectedVersion:'v1',idempotencyKey:'command',callId:'call',quantity:15,date:'2026-09-08',reference:'LOT-CLIENT-TEST',note:'Réception fictive de recette'};
const audit={user_id:1} as never;
let current:ReturnType<typeof coverage>;
let tx:{query:ReturnType<typeof vi.fn>;release:ReturnType<typeof vi.fn>};
beforeEach(()=>{
  vi.resetAllMocks();current=coverage();tx={query:vi.fn().mockResolvedValue({rows:[]}),release:vi.fn()};
  m.command.mockImplementation((_of,_type,_body,_audit,work)=>withRealtimeOutboxTransaction(tx as never,client=>work(client,current)));
  m.read.mockImplementation(async()=>current);m.receive.mockResolvedValue({receptionId:'receipt',receptionNo:'RF-TEST',lineId:'line',lotId:'lot'});
});
describe('customer material calls',()=>{
  it('receives only the partial quantity under the caller transaction and the true owner',async()=>{
    const result=await commandCustomerMaterial(19,body,audit);
    expect(result.reception?.receptionId).toBe('receipt');expect(m.receive).toHaveBeenCalledWith(tx,expect.objectContaining({quantity:15,clientId:'client',callId:'call',articleId:'article',unit:'u'}),audit);
    expect(tx.query).toHaveBeenCalledWith('COMMIT');expect(tx.release).toHaveBeenCalledTimes(1);
  });
  it('rejects receiving more than the 30 remaining',async()=>{
    await expect(commandCustomerMaterial(19,{...body,quantity:31},audit)).rejects.toMatchObject({code:'CUSTOMER_MATERIAL_OVER_RECEIPT'});expect(m.receive).not.toHaveBeenCalled();
  });
  it('rolls back the call update if receipt or lot creation fails',async()=>{
    m.receive.mockRejectedValue(new Error('lot failed'));await expect(commandCustomerMaterial(19,body,audit)).rejects.toThrow('lot failed');
    expect(tx.query).toHaveBeenCalledWith('ROLLBACK');expect(tx.query).not.toHaveBeenCalledWith('COMMIT');
  });
  it('refuses to use the material of another customer',async()=>{
    current.needs[0].requirements.ownerClientId='another';await expect(commandCustomerMaterial(19,body,audit)).rejects.toMatchObject({code:'CUSTOMER_MATERIAL_REVISION_CHANGED'});expect(m.receive).not.toHaveBeenCalled();
  });
  it('preserves an already received call instead of cancelling its history',async()=>{
    await expect(commandCustomerMaterial(19,{action:'CANCEL',expectedVersion:'v1',idempotencyKey:'command',callId:'call',note:'Annulation demandée avec motif'},audit)).rejects.toMatchObject({code:'CUSTOMER_MATERIAL_RECEIVED'});
  });
  it('requires an actual transmitted request reference before receipt',async()=>{
    current.customerCalls[0].status='PREPARED';await expect(commandCustomerMaterial(19,body,audit)).rejects.toMatchObject({code:'CUSTOMER_MATERIAL_SEND_REQUIRED'});
  });
  it('prepares only the uncovered quantity and freezes the requirements',async()=>{
    await commandCustomerMaterial(19,{action:'PREPARE',expectedVersion:'v1',idempotencyKey:'command',needKey:'source',quantity:60,needDate:'2026-09-18',note:'Appel client de recette'},audit);
    const insert=tx.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO public.of_customer_material_calls'));
    expect(insert?.[1]).toEqual(['need','client',60,'u',JSON.stringify(current.needs[0].requirements),'2026-09-18','Appel client de recette',1]);expect(m.receive).not.toHaveBeenCalled();
  });
  it('does not duplicate previously promised quantities',async()=>{
    await expect(commandCustomerMaterial(19,{action:'PREPARE',expectedVersion:'v1',idempotencyKey:'command',needKey:'source',quantity:61,needDate:'2026-09-18',note:'Appel client de recette'},audit)).rejects.toMatchObject({code:'CUSTOMER_MATERIAL_OVER_COVERAGE'});
  });
  it('cannot create a customer call for a purchase need',async()=>{
    current.needs[0].supplyMode='PURCHASE';await expect(commandCustomerMaterial(19,{action:'PREPARE',expectedVersion:'v1',idempotencyKey:'command',needKey:'source',quantity:10,needDate:'2026-09-18',note:'Appel client de recette'},audit)).rejects.toMatchObject({code:'CUSTOMER_MATERIAL_PREPARATION_REQUIRED'});
  });
});
