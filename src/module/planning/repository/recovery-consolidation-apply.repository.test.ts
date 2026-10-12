import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {AuditContext} from '../../production/repository/production.repository';
const mocks=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),context:vi.fn(),control:vi.fn(),holds:vi.fn(),components:vi.fn(),dossier:vi.fn(),commitments:vi.fn(),audit:vi.fn(),ofAudit:vi.fn(),enqueue:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{connect:vi.fn(async()=>({query:mocks.query,release:mocks.release}))}}));
vi.mock('./recovery-consolidation-context.repository',()=>({readRecoveryConsolidationContextTx:mocks.context}));
vi.mock('./recovery-consolidation-preview.repository',()=>({readRecoveryConsolidationControlTx:mocks.control}));
vi.mock('./recovery-consolidation-commitments.repository',()=>({applyRecoveryCommitmentsTx:mocks.commitments}));
vi.mock('../../production/repository/recovery-consolidation-holds.repository',()=>({appendRecoveryConsolidationHoldsTx:mocks.holds}));
vi.mock('../../production/repository/of-component-coverage.repository',()=>({readOfComponentCoverageTx:mocks.components}));
vi.mock('../../production/repository/recovery-consolidation-dossier.repository',()=>({validateRecoveryProducerDossierTx:mocks.dossier}));
vi.mock('../../production/repository/production-preparation.repository',()=>({preparationAudit:mocks.ofAudit}));
vi.mock('../../audit-logs/repository/audit-logs.repository',()=>({repoInsertAuditLog:mocks.audit}));
vi.mock('../../../shared/realtime/realtime-outbox.service',()=>({enqueueEntityChanged:mocks.enqueue}));
import {applyRecoveryGrouping} from './recovery-consolidation-apply.repository';
const now='2026-10-12T08:00:00.000Z',reference='2026-10-12T08:01:00.000Z';
const body={expected_request_version:2,preview_hash:'a'.repeat(64),proposal_hash:'b'.repeat(64),planning_reference_at:reference,idempotency_key:'9f8483e3-0178-4813-bfa9-c447cb2a3a53'};
const audit={user_id:8} as AuditContext;
let decision:{request_hash:string;response:unknown}|undefined,activation:string;
const context=()=>({producer:{id:10,technicalHash:'c'.repeat(64)},recovery:{id:20,commande_id:30,updated_at:now},context:{request_id:'request',request_status:'WAITING_PLANNER',donor_snapshot:{}}});
const control=()=>({context:context(),material:{version:'material'},components:[{ofId:20,assembly:false,version:'components'}],
 snapshot:{tasks:[{id:'op:cut',operationId:'cut',ofId:10,source:'OPERATION',resourceIds:['machine:1'],committed:{start:now,end:'2026-10-12T10:00:00.000Z'}}]},
 response:{request_version:2,preview_hash:body.preview_hash,proposal_hash:body.proposal_hash,planning_revision:'7',feasible:true,previous_quantity:100,additional_quantity:10,proposed_quantity:110,proposed_finish:'2026-10-12T10:10:00.000Z',finish_before:'2026-10-13T22:00:00.000Z',changes:[{taskId:'op:cut',resourceIds:['machine:1'],after:{start:now,end:'2026-10-12T10:10:00.000Z'}}],issues:[]}});
function query(sql:string,p:unknown[]=[]){
 if(sql.includes('SELECT revision::text,activation'))return {rows:[{revision:'7',activation}]};
 if(sql.includes('SELECT request_hash,response'))return {rows:decision?[decision]:[]};
 if(sql.includes('INSERT INTO public.production_recovery_consolidation_additions'))decision={request_hash:String(p[14]),response:JSON.parse(String(p[18]))};
 if(sql==='ROLLBACK')decision=undefined;
 return {rows:[]};
}
const call=(input=body)=>applyRecoveryGrouping('recovery','group',input,audit);
beforeEach(()=>{vi.resetAllMocks();vi.useFakeTimers();vi.setSystemTime(new Date(now));decision=undefined;activation='COMMIT';mocks.query.mockImplementation(query);
 mocks.context.mockResolvedValue(context());mocks.control.mockImplementation(async()=>control());mocks.holds.mockResolvedValue([]);mocks.components.mockResolvedValue({ready:true,version:'components'});
});
afterEach(()=>vi.useRealTimers());
describe('atomic addition of a recovery to a running group',()=>{
 it('commits exact quantity, ownership, refreshed dossier and reviewed slots together without authorizing withdrawal',async()=>{
  expect(await call()).toMatchObject({replayed:false,addition:{quantity:110,added_quantity:10,can_withdraw:false,requires_urgency_approval:true}});
  const sql=mocks.query.mock.calls.map(c=>c[0]);expect(sql.slice(0,2)).toEqual(['BEGIN','SET TRANSACTION ISOLATION LEVEL SERIALIZABLE']);expect(sql.at(-1)).toBe('COMMIT');
  expect(sql.some(s=>s.includes('UPDATE public.of_component_requirements'))).toBe(true);
  expect(sql.some(s=>s.includes('INSERT INTO public.production_consolidation_allocations'))).toBe(true);
  expect(sql.filter(s=>s.includes('UPDATE public.ordres_fabrication'))).toHaveLength(1);
  expect(mocks.commitments.mock.invocationCallOrder[0]).toBeLessThan(mocks.dossier.mock.invocationCallOrder[0]);
  expect(sql.at(-2)).toContain('SET CONSTRAINTS recovery_consolidation_addition_complete');expect(mocks.enqueue).toHaveBeenCalledOnce();expect(mocks.release).toHaveBeenCalledOnce();
 });
 it('reconciles the original request after timeout, clock expiry or planning deactivation without a second addition',async()=>{
  const first=await call();vi.setSystemTime(new Date('2026-10-12T09:00:00.000Z'));activation='OBSERVE';
  expect(await call()).toEqual({...first,replayed:true});expect(mocks.holds).toHaveBeenCalledOnce();expect(mocks.enqueue).toHaveBeenCalledOnce();
  await expect(call({...body,expected_request_version:3})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 });
 it.each(['expected_request_version','preview_hash','proposal_hash'] as const)('rejects stale %s before any mutation',key=>{
  const altered={...body,[key]:key==='expected_request_version'?3:'d'.repeat(64)};
  return expect(call(altered)).rejects.toMatchObject({code:'RECOVERY_GROUPING_CHANGED'}).then(()=>{expect(decision).toBeUndefined();expect(mocks.holds).not.toHaveBeenCalled();});
 });
 it.each(['2026-10-12T07:59:59.999Z','2026-10-12T08:03:00.000Z'])('requires the same bounded planning instant (%s)',planning_reference_at=>
  expect(call({...body,planning_reference_at})).rejects.toMatchObject({code:'RECOVERY_PROPOSAL_EXPIRED'}));
 it('rejects a newly closed cutting gate or any current preview blocker',async()=>{
  mocks.control.mockResolvedValue({...control(),response:{...control().response,feasible:false,issues:[{code:'GROUPING_CUTTING_FINISHED'}]}});
  await expect(call()).rejects.toMatchObject({code:'RECOVERY_GROUPING_NOT_READY'});expect(mocks.holds).not.toHaveBeenCalled();
 });
 it('rolls back transferred holds when component quality changes before ownership transfer',async()=>{
  mocks.components.mockResolvedValue({ready:false,version:'components'});await expect(call()).rejects.toMatchObject({code:'RECOVERY_COMPONENTS_CHANGED'});
  expect(mocks.holds).toHaveBeenCalledOnce();expect(decision).toBeUndefined();expect(mocks.commitments).not.toHaveBeenCalled();expect(mocks.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
 });
 it.each(['dossier','commitments','enqueue'] as const)('rolls back every write if %s fails',async step=>{
  mocks[step].mockRejectedValue(new Error('failed'));await expect(call()).rejects.toThrow('failed');expect(decision).toBeUndefined();
  expect(mocks.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');expect(mocks.release).toHaveBeenCalledOnce();
 });
 it('forces deferred guards before reporting success',async()=>{
  mocks.query.mockImplementation((sql,p)=>{if(sql.startsWith('SET CONSTRAINTS recovery_consolidation'))throw Object.assign(new Error('incomplete'),{code:'23514'});return query(sql,p)});
  await expect(call()).rejects.toMatchObject({code:'23514'});expect(decision).toBeUndefined();expect(mocks.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
 });
 it('returns a recoverable conflict after a concurrent planning change',async()=>{
  mocks.holds.mockRejectedValue(Object.assign(new Error('changed'),{code:'40001'}));await expect(call()).rejects.toMatchObject({code:'RECOVERY_GROUPING_BUSY'});expect(decision).toBeUndefined();
 });
});
