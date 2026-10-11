import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({ query:vi.fn(),release:vi.fn(),read:vi.fn(),generate:vi.fn(),audit:vi.fn(),ofAudit:vi.fn(),enqueue:vi.fn() }));
vi.mock('../../../config/database',()=>({default:{connect:vi.fn(async()=>({query:mocks.query,release:mocks.release}))}}));
vi.mock('./delivery-urgency.repository',()=>({readDeliveryUrgencyPlan:mocks.read}));
vi.mock('../../production/domain/of-generation',()=>({createRecursiveOrdresFabrication:mocks.generate}));
vi.mock('../../production/repository/production-preparation.repository',()=>({preparationAudit:mocks.ofAudit}));
vi.mock('../../audit-logs/repository/audit-logs.repository',()=>({repoInsertAuditLog:mocks.audit}));
vi.mock('../../../shared/realtime/realtime-outbox.service',()=>({enqueueEntityChanged:mocks.enqueue}));
vi.mock('../../stock/repository/stock-lane-routing.repository',()=>({lockStockLaneTopology:vi.fn()}));
import { repoCreateDeliveryUrgencyRequest } from './delivery-urgency-request.repository';
import type { AuditContext } from '../../production/repository/production.repository';
const audit:AuditContext={user_id:8,ip:null,user_agent:null,device_type:null,os:null,browser:null,path:null,page_key:null,client_session_id:null};
const args={allocationId:1,body:{quantity:'5',preview_hash:'a'.repeat(64),reason:'Livraison urgente demandée'},idempotencyKey:'d59dc5f0-6207-408e-bda2-0e2dd3c6bdc0',audit};
const donor=(id:string)=>({reservation_id:id,allocation_id:2,client_id:'195',article_id:'article1',
  commande_id:20,commande_numero:'CC20',commande_ligne_id:21,livraison_affaire_id:22,
  piece_technique_id:'pt1',technical_version_id:'donor-version',initial_ar_due_date:'2026-12-10',lot_id:'lot1'});
const plan=()=>({context:{client_id:'195',commande_id:10,livraison_affaire_id:12},donors:[donor('r1'),donor('r2')],
  response:{requested_quantity:'5',free_quantity:'0',shortage_quantity:'0',recovery_quantity:'5',preview_hash:args.body.preview_hash,
    donors:[{reservation_id:'r1',allocation_id:2,proposed_quantity:'2',protected_due_date:'2026-11-30'},
      {reservation_id:'r2',allocation_id:2,proposed_quantity:'3',protected_due_date:'2026-11-30'}]}});
let storedId:string|undefined;
const defaultQuery=async(sql:string,values:unknown[]=[])=>{
  if(sql.includes('INSERT INTO public.delivery_urgency_requests')) storedId=String(values[0]);
  if(sql.includes('SELECT id::text,beneficiary_allocation_id')) return {rows:storedId?[{id:storedId,status:'WAITING_PLANNER',quantity:'5',version:1}]:[]};
  return {rows:[]};
};
beforeEach(()=>{
  vi.clearAllMocks(); storedId=undefined; mocks.query.mockImplementation(defaultQuery);
  mocks.read.mockImplementation(async()=>plan()); mocks.generate.mockResolvedValue({root_of_id:101,ofs:[{id:101}]});
});
describe('durable urgency recovery requests',()=>{
  it('creates one exact recovery draft for two donor lots, linked to the donor order and affair',async()=>{
    const result=await repoCreateDeliveryUrgencyRequest(args);
    expect(result).toMatchObject({request:{status:'WAITING_PLANNER',can_withdraw:false},replayed:false});
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(mocks.generate).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
      commande_id:20,commande_ligne_id:21,livraison_affaire_id:22,root_piece_technique_id:'pt1',
      root_pinned_version_id:'donor-version',qty_to_produce:5,force_preparation:true,
    }));
    expect(mocks.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO public.delivery_urgency_sources'))).toHaveLength(2);
    expect(mocks.query.mock.calls.some(([sql])=>/UPDATE public\.(stock_|commande_ligne_affaire_allocation)/.test(sql))).toBe(false);
    expect(mocks.ofAudit).toHaveBeenCalledWith(expect.anything(),audit,101,'production.of.urgency-recovery.prepare',
      expect.objectContaining({finish_before:'2026-11-30',initial_ar_due_date:'2026-12-10',withdrawal_authorized:false}));
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('COMMIT'); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it('replays the persisted request without creating another OF',async()=>{
    await repoCreateDeliveryUrgencyRequest(args);
    const insert=mocks.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO public.delivery_urgency_requests'))!;
    const requestHash=insert[1][7]; mocks.query.mockImplementation(async(sql:string,values:unknown[]=[])=>
      sql.includes('SELECT id::text,request_hash')?{rows:[{id:storedId,request_hash:requestHash}]}:defaultQuery(sql,values));
    const reads=mocks.read.mock.calls.length;
    expect(await repoCreateDeliveryUrgencyRequest(args)).toMatchObject({replayed:true});
    expect(mocks.generate).toHaveBeenCalledOnce(); expect(mocks.read.mock.calls.length).toBe(reads);
  });
  it('rejects reusing an idempotency key for different input',async()=>{
    mocks.query.mockImplementation(async(sql:string)=>({rows:sql.includes('SELECT id::text,request_hash')?[{id:'existing',request_hash:'different'}]:[]}));
    await expect(repoCreateDeliveryUrgencyRequest(args)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('rejects a concurrent change after acquiring the donor locks',async()=>{
    mocks.read.mockResolvedValueOnce(plan()).mockResolvedValueOnce({...plan(),response:{...plan().response,preview_hash:'b'.repeat(64)}});
    await expect(repoCreateDeliveryUrgencyRequest(args)).rejects.toMatchObject({code:'URGENCY_PREVIEW_CHANGED'});
    expect(mocks.generate).not.toHaveBeenCalled(); expect(storedId).toBeUndefined();
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
  it('keeps the original request when another request for the same affair is pending',async()=>{
    mocks.query.mockImplementation(async(sql:string,values:unknown[]=[])=>
      sql.includes("status IN('WAITING_PLANNER','APPROVED')")?{rows:[{id:'pending'}]}:defaultQuery(sql,values));
    await expect(repoCreateDeliveryUrgencyRequest(args)).rejects.toMatchObject({code:'URGENCY_ALREADY_PENDING'});
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it.each([['free_quantity','1','URGENCY_USE_FREE_STOCK_FIRST'],['shortage_quantity','1','URGENCY_DONORS_INSUFFICIENT']])
    ('refuses an inappropriate draft: %s',async(field,value,code)=>{
      mocks.read.mockResolvedValue({...plan(),response:{...plan().response,[field]:value}});
      await expect(repoCreateDeliveryUrgencyRequest(args)).rejects.toMatchObject({code});
      expect(mocks.generate).not.toHaveBeenCalled(); expect(storedId).toBeUndefined();
    });
  it('rolls back the entire request if canonical OF generation fails',async()=>{
    mocks.generate.mockRejectedValueOnce(new Error('technical definition missing'));
    await expect(repoCreateDeliveryUrgencyRequest(args)).rejects.toThrow('technical definition missing');
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it('returns a conflict rather than a server error if a donor is already locked',async()=>{
    mocks.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{
      if(sql.includes('FROM public.stock_reservations')) throw Object.assign(new Error('busy'),{code:'55P03'});
      return defaultQuery(sql,values);
    });
    await expect(repoCreateDeliveryUrgencyRequest(args)).rejects.toMatchObject({status:409,code:'URGENCY_BUSY'});
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
