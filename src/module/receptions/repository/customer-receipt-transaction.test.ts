import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({connect:vi.fn(),audit:vi.fn(),code:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{connect:m.connect}}));
vi.mock('../../../shared/codes/code-generator.service',()=>({generateTransactionalBusinessCode:m.code}));
vi.mock('../../stock/repository/stock.repository',()=>({repoCreateMovement:vi.fn(),repoPostMovement:vi.fn(),repoGetMovement:vi.fn()}));
vi.mock('../../production/repository/of-material-receipts.repository',()=>({lockMaterialReceiptRecipientsTx:vi.fn(),transferMaterialReceiptTx:vi.fn()}));
vi.mock('../../commande-fournisseur/repository/commande-fournisseur.repository',()=>({repoRefreshCommandeReceptionState:vi.fn()}));
vi.mock('../../audit-logs/repository/audit-logs.repository',()=>({repoInsertAuditLog:m.audit}));
vi.mock('./receptions-realtime.repository',()=>({enqueueReceptionChanged:vi.fn(),receptionRealtimeActionFromAudit:()=> 'updated'}));
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {createCustomerMaterialReceiptTx,repoCreateLine,type AuditContext} from './receptions.repository';
const audit:AuditContext={user_id:1,ip:null,user_agent:null,device_type:null,os:null,browser:null,path:null,page_key:null,client_session_id:null};
const input={callId:'call',clientId:'client',articleId:'article',designation:'Matière client',quantity:15,unit:'u',date:'2026-09-08',reference:'LOT-CLIENT-TEST',note:'Réception partielle fictive'};
let tx:{query:ReturnType<typeof vi.fn>;release:ReturnType<typeof vi.fn>},lotCreated:boolean;
beforeEach(()=>{
  vi.resetAllMocks();lotCreated=false;m.audit.mockResolvedValue({id:'audit',created_at:'2026-09-08'});m.code.mockResolvedValue('LOT-TEST');
  tx={release:vi.fn(),query:vi.fn(async(sql:string)=>{
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows:[]};
    if(sql.includes('nextval'))return {rows:[{n:'3'}]};
    if(sql.includes('INSERT INTO public.receptions_fournisseurs'))return {rows:[{id:'receipt',reception_no:'RF-TEST'}]};
    if(sql.includes('SELECT 1::int AS ok,origin_type,status'))return {rows:[{ok:1,origin_type:'CUSTOMER',status:'OPEN'}]};
    if(sql.includes('MAX(line_no)'))return {rows:[{next_no:1}]};
    if(sql.includes('SELECT unite FROM public.articles'))return {rows:[{unite:'u'}]};
    if(sql.includes('INSERT INTO public.reception_fournisseur_lignes'))return {rows:[{id:'line'}]};
    if(sql.includes('a.code AS article_code'))return {rows:[{id:'line',article_id:'article',qty_received:15,lot_id:lotCreated?'lot':null}]};
    if(sql.includes('r.client_proprietaire_id AS owner_client_id'))return {rows:[{id:'line',reception_id:'receipt',article_id:'article',lot_id:null,owner_client_id:'client'}]};
    if(sql.includes('INSERT INTO public.lots')){lotCreated=true;return {rows:[{id:'lot'}]};}
    if(sql.includes('UPDATE public.reception_fournisseur_lignes'))return {rows:[]};
    throw new Error(`Unexpected customer receipt query: ${sql}`);
  })};m.connect.mockResolvedValue(tx);
});
describe('customer receipt transaction and ownership',()=>{
  it('uses the canonical receipt, line and lot in one transaction with no supplier',async()=>{
    const result=await withRealtimeOutboxTransaction(tx as never,client=>createCustomerMaterialReceiptTx(client,input,audit));
    expect(result).toEqual({receptionId:'receipt',receptionNo:'RF-TEST',lineId:'line',lotId:'lot'});
    const header=tx.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO public.receptions_fournisseurs'));
    expect(header?.[0]).toContain("'CUSTOMER'");expect(header?.[0]).toContain("NULL,'OPEN'");expect(header?.[1]?.[1]).toBe('client');
    const line=tx.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO public.reception_fournisseur_lignes'));
    expect(line?.[1]?.[8]).toBeNull();expect(line?.[1]?.[12]).toBe('call');
    const lot=tx.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO public.lots'));
    expect(lot?.[1]?.[7]).toBe('EN_ATTENTE');expect(lot?.[1]?.[10]).toBe('client');
    expect(m.connect).not.toHaveBeenCalled();expect(tx.query.mock.calls.filter(([sql])=>sql==='BEGIN')).toHaveLength(1);expect(tx.query.mock.calls.filter(([sql])=>sql==='COMMIT')).toHaveLength(1);expect(tx.release).toHaveBeenCalledTimes(1);
  });
  it('rolls back the whole receipt when the lot cannot be created',async()=>{
    m.code.mockRejectedValue(new Error('number unavailable'));
    await expect(withRealtimeOutboxTransaction(tx as never,client=>createCustomerMaterialReceiptTx(client,input,audit))).rejects.toThrow('number unavailable');
    expect(tx.query).toHaveBeenCalledWith('ROLLBACK');expect(tx.query).not.toHaveBeenCalledWith('COMMIT');expect(tx.release).toHaveBeenCalledTimes(1);
  });
  it('keeps the outer transaction owned by its caller',async()=>{
    m.code.mockRejectedValue(new Error('number unavailable'));
    await expect(createCustomerMaterialReceiptTx(tx as never,input,audit)).rejects.toThrow('number unavailable');
    expect(tx.query.mock.calls.some(([sql])=>['BEGIN','COMMIT','ROLLBACK'].includes(sql))).toBe(false);expect(tx.release).not.toHaveBeenCalled();
  });
  it('prevents legacy receipt routes from creating unassigned customer lines',async()=>{
    await expect(repoCreateLine('receipt',{article_id:'article',qty_received:15,unite:'u'},audit)).rejects.toMatchObject({code:'CUSTOMER_MATERIAL_CALL_REQUIRED'});
    expect(tx.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO public.reception_fournisseur_lignes'))).toBe(false);
  });
});
