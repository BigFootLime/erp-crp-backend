import { beforeEach, describe, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ query:vi.fn(),release:vi.fn(),review:vi.fn(),read:vi.fn(),restore:vi.fn(),coverage:vi.fn(),quality:vi.fn(),audit:vi.fn(),ofAudit:vi.fn(),enqueue:vi.fn() }));
vi.mock('../../../config/database',()=>({default:{connect:vi.fn(async()=>({query:ports.query,release:ports.release}))}}));
vi.mock('./delivery-urgency-cancellation-preview.repository',()=>({readUrgencyCancellationTx:ports.review}));
vi.mock('./delivery-urgency-request.repository',()=>({readUrgencyRequests:ports.read}));
vi.mock('./urgency-restitution-stock.repository',()=>({restoreUrgencyStockTx:ports.restore}));
vi.mock('./urgency-withdrawal-stock.repository',()=>({refreshUrgencyDonorCoverageTx:ports.coverage}));
vi.mock('../../qualite/repository/quality-operational-gate.repository',()=>({assertOperationalLotQualityEligibility:ports.quality}));
vi.mock('../../stock/repository/stock-lane-routing.repository',()=>({lockStockLaneTopology:vi.fn()}));
vi.mock('../../production/repository/production-preparation.repository',()=>({preparationAudit:ports.ofAudit}));
vi.mock('../../audit-logs/repository/audit-logs.repository',()=>({repoInsertAuditLog:ports.audit}));
vi.mock('../../../shared/realtime/realtime-outbox.service',()=>({enqueueEntityChanged:ports.enqueue}));
import { repoRestoreDeliveryUrgency } from './delivery-urgency-restitution.repository';
import { deliveryUrgencyRestitutionBody } from '../validators/delivery-urgency.validators';
import type { AuditContext } from '../../production/repository/production.repository';
const audit:AuditContext={user_id:8,ip:null,user_agent:null,device_type:null,os:null,browser:null,path:null,page_key:null,client_session_id:null};
const args={requestId:'request',body:{expected_version:3,preview_hash:'a'.repeat(64),reason:'Urgence annulée par le client',fee_decision:'KEEP' as const},idempotencyKey:'key',audit};
const review=()=>({request:{id:'request',status:'WITHDRAWN',version:3},tree:[{id:101},{id:102}],
 response:{request_version:3,preview_hash:args.body.preview_hash,can_cancel:true,issues:[]},
 restitution:{response:{can_restore:true,quantity:'10',donor_quantity:'6',free_quantity:'4'},evidence:{
  request:{commande_id:10},fee:{id:'fee'},recoveries:[{donor_allocation_id:2,commande_id:20}],
  reservations:[{id:'reservation',lot_id:'lot',source_scope:'NEW',unit:'u',stock_level_id:'level',stock_batch_id:'batch'}]}}});
const query=async(sql:string)=>({rows:sql.includes('SELECT\n      beneficiary_allocation_id')?[{beneficiary_allocation_id:1,status:'WITHDRAWN',version:3,withdrawn_id:'withdrawal'}]:[]});
beforeEach(()=>{vi.resetAllMocks();ports.query.mockImplementation(query);ports.review.mockImplementation(async()=>review());ports.read.mockResolvedValue([{id:'request',status:'CANCELLED'}]);});

describe('complete urgency restitution transaction',()=>{
 it('requires explicit retention of the order fee',()=>{
  expect(deliveryUrgencyRestitutionBody.safeParse(args.body).success).toBe(true);
  expect(deliveryUrgencyRestitutionBody.safeParse({...args.body,fee_decision:undefined}).success).toBe(false);
  expect(deliveryUrgencyRestitutionBody.safeParse({...args.body,fee_decision:'REMOVE'}).success).toBe(false);
 });
 it('returns stock, retains OFs and fee, closes the request and notifies both orders atomically',async()=>{
  const result=await repoRestoreDeliveryUrgency(args);
  expect(result).toMatchObject({request:{status:'CANCELLED'},restitution:{donor_quantity:'6',free_quantity:'4',fee_decision:'KEEP'},replayed:false});
  expect(ports.restore).toHaveBeenCalledOnce();expect(ports.coverage).toHaveBeenCalledWith(expect.anything(),[1,2]);
  expect(ports.ofAudit).toHaveBeenCalledTimes(2);expect(ports.enqueue).toHaveBeenCalledTimes(2);
  const sql=ports.query.mock.calls.map(([s])=>s as string);
  expect(sql.at(-1)).toBe('COMMIT');expect(sql.some(s=>/UPDATE public\.(ordres_fabrication|delivery_urgency_order_charges|invoices)/.test(s))).toBe(false);
  expect(ports.release).toHaveBeenCalledOnce();
 });
 it('replays a committed response without returning stock twice',async()=>{
  await repoRestoreDeliveryUrgency(args);
  const header=ports.query.mock.calls.find(([s])=>s.includes('INSERT INTO public.delivery_urgency_restitutions'))!;
  const hash=header[1][11];ports.query.mockImplementation(async(sql:string)=>sql.includes('SELECT restitution.request_hash')
   ?{rows:[{request_hash:hash,response:{id:'saved',donor_quantity:'6'},beneficiary_allocation_id:1}]}:query(sql));
  expect(await repoRestoreDeliveryUrgency(args)).toMatchObject({replayed:true,restitution:{id:'saved'}});
  expect(ports.restore).toHaveBeenCalledOnce();expect(ports.review).toHaveBeenCalledTimes(2);
 });
 it('rejects changed input for the same idempotency key',async()=>{
  ports.query.mockImplementation(async(sql:string)=>sql.includes('SELECT restitution.request_hash')?{rows:[{request_hash:'other'}]}:query(sql));
  await expect(repoRestoreDeliveryUrgency(args)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});expect(ports.restore).not.toHaveBeenCalled();
 });
 it('requires the current withdrawn version before reading or mutating stock',async()=>{
  await expect(repoRestoreDeliveryUrgency({...args,body:{...args.body,expected_version:2}})).rejects.toMatchObject({code:'URGENCY_REQUEST_CHANGED'});
  expect(ports.review).not.toHaveBeenCalled();expect(ports.restore).not.toHaveBeenCalled();
 });
 it('rejects a prepared or shipped reservation with no stock mutation',async()=>{
  const blocked=review();blocked.restitution.response.can_restore=false;ports.review.mockResolvedValue(blocked);
  await expect(repoRestoreDeliveryUrgency(args)).rejects.toMatchObject({code:'URGENCY_RETURN_NOT_READY'});
  expect(ports.restore).not.toHaveBeenCalled();
 });
 it('refreshes the review after locks and rejects a changed replenishment or fee',async()=>{
  ports.review.mockResolvedValueOnce(review()).mockResolvedValueOnce({...review(),response:{...review().response,preview_hash:'b'.repeat(64)}});
  await expect(repoRestoreDeliveryUrgency(args)).rejects.toMatchObject({code:'URGENCY_RETURN_CHANGED'});
  expect(ports.restore).not.toHaveBeenCalled();expect(ports.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 });
 it('rolls back stock, cancellation and notifications if a movement fails',async()=>{
  ports.restore.mockRejectedValueOnce(new Error('physical transfer failed'));
  await expect(repoRestoreDeliveryUrgency(args)).rejects.toThrow('physical transfer failed');
  expect(ports.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(ports.coverage).not.toHaveBeenCalled();expect(ports.enqueue).not.toHaveBeenCalled();
 });
 it('rolls back the entire operation if its notification cannot be queued',async()=>{
  ports.enqueue.mockRejectedValueOnce(new Error('outbox failure'));
  await expect(repoRestoreDeliveryUrgency(args)).rejects.toThrow('outbox failure');
  expect(ports.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 });
 it.each(['55P03','40P01','40001'])('reports concurrency %s as a refreshable conflict',async code=>{
  ports.quality.mockRejectedValueOnce(Object.assign(new Error('busy'),{code}));
  await expect(repoRestoreDeliveryUrgency(args)).rejects.toMatchObject({status:409,code:'URGENCY_RETURN_BUSY'});
  expect(ports.restore).not.toHaveBeenCalled();expect(ports.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 });
});
