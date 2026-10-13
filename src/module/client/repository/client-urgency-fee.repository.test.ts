import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),audit:vi.fn(),enqueue:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{connect:async()=>({query:mocks.query,release:mocks.release})}}));
vi.mock('../../audit-logs/repository/audit-logs.repository',()=>({repoInsertAuditLog:mocks.audit}));
vi.mock('../../../shared/realtime/realtime-outbox.service',()=>({enqueueEntityChanged:mocks.enqueue}));
import {repoSaveClientUrgencyFee} from './client-urgency-fee.repository';
import {clientUrgencyFeeBody} from '../validators/client-urgency-fee.validators';
import type {AuditContext} from './client.repository';
const audit:AuditContext={user_id:8,ip:null,user_agent:null,device_type:null,os:null,browser:null,path:null,page_key:null,client_session_id:null};
const body={amount_ht:'35.50',currency:'EUR',expected_version:0};
let client: {client_id:string;client_active:boolean;client_currency:string;version:number};
beforeEach(()=>{
  vi.clearAllMocks(); client={client_id:'C1',client_active:true,client_currency:'EUR',version:0};
  mocks.query.mockImplementation(async(sql:string)=>{
    if(sql.includes('INSERT INTO public.client_urgency_fee_settings')) client.version++;
    return {rows:sql.includes('FROM public.clients c LEFT JOIN')?[{...client}]:[]};
  });
});
describe('explicit client urgency tariff',()=>{
  it('normalizes decimal/currency values and refuses unconstrained free text',()=>{
    expect(clientUrgencyFeeBody.parse({amount_ht:' 35.5 ',currency:' eur ',expected_version:0})).toEqual(body);
    for(const amount_ht of ['-2','1e3','1,5','1.234','1000000000','NaN',''])
      expect(clientUrgencyFeeBody.safeParse({...body,amount_ht}).success).toBe(false);
  });
  it('saves with audit and notification in the same transaction',async()=>{
    expect(await repoSaveClientUrgencyFee('C1',body,audit)).toMatchObject({version:1});
    expect(mocks.audit).toHaveBeenCalledOnce();expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('COMMIT'); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each([['version',1,'URGENCY_FEE_CHANGED'],['client_active',false,'CLIENT_INACTIVE'],['client_currency','USD','URGENCY_FEE_CURRENCY_CHANGED']])
    ('refuses stale or unusable client state: %s',async(field,value,code)=>{
      Object.assign(client,{[field]:value});
      await expect(repoSaveClientUrgencyFee('C1',body,audit)).rejects.toMatchObject({code});
      expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    });
  it('rolls back a tariff update if its audit cannot be recorded',async()=>{
    mocks.audit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(repoSaveClientUrgencyFee('C1',body,audit)).rejects.toThrow('audit unavailable');
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
