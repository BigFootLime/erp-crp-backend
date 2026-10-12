import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {CentralSnapshot,CentralTask,ScheduleChange} from '../types/planning-central.types';
import type {AuditContext} from '../../production/repository/production.repository';
vi.mock('./planning.repository',()=>({assertOperationResourceCompatible:vi.fn(),assertResourceSchedulable:vi.fn(),syncPlanningCoordinates:vi.fn()}));
import {applyRecoveryCommitmentsTx} from './recovery-consolidation-commitments.repository';

const start='2026-10-12T08:00:00Z',end='2026-10-13T08:00:00Z',extended='2026-10-14T08:00:00Z';
const audit={user_id:8} as AuditContext;
const query=vi.fn(),tx={query} as unknown as PoolClient;
const task=()=>({id:'op:service',operationId:'service',ofId:10,source:'OPERATION',external:true,
  resourceIds:['supplier:coat','supplier:polish'],commitment:'STARTED',locked:false,
  actual:{start},committed:{start,end}} as unknown as CentralTask);
const snapshot=(t=task())=>({tasks:[t]} as CentralSnapshot);
const change=()=>({taskId:'op:service',resourceIds:['supplier:coat','supplier:polish'],after:{start,end:extended}} as ScheduleChange);
beforeEach(()=>{
  query.mockReset().mockImplementation(async(sql:string)=>({rows:sql.includes('SELECT committed_start')?[{start,end}]:[]}));
});
describe('supplier planning commitments during a recovery addition',()=>{
  it('extends the canonical commitment while preserving departure and supplier shipment history',async()=>{
    const result=await applyRecoveryCommitmentsTx(tx,10,snapshot(),[change()],audit);
    expect(result).toEqual([{operation_id:'service',start,end:extended,resource_id:'supplier:coat'}]);
    const writes=query.mock.calls.filter(([sql])=>/^\s*(UPDATE|INSERT)/.test(sql));
    expect(writes.map(([sql])=>sql.match(/(?:UPDATE|INSERT INTO)\s+([^\s(]+)/)?.[1])).toEqual([
      'public.planning_tasks','public.planning_central_settings','public.planning_recalculation_jobs']);
    expect(writes[0][1]).toEqual(['op:service',start,extended]);
    expect(query.mock.calls.at(-1)?.[0]).toContain('IMMEDIATE');
  });
  it('does not duplicate or rewrite an already matching supplier commitment',async()=>{
    await applyRecoveryCommitmentsTx(tx,10,snapshot(),[],audit);
    expect(query.mock.calls.some(([sql])=>/^\s*(UPDATE|INSERT)/.test(sql))).toBe(false);
  });
  it('refuses a changed departure time on a service already in progress',async()=>{
    await expect(applyRecoveryCommitmentsTx(tx,10,snapshot(),[{...change(),after:{start:'2026-10-12T09:00:00Z',end:extended}}],audit))
      .rejects.toMatchObject({code:'RECOVERY_RUNNING_OPERATION_MOVED'});
    expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
  });
  it.each(['missing','legacy','stale'] as const)('requires an unambiguous current supplier commitment: %s',async(mode)=>{
    query.mockImplementation(async(sql:string)=>({rows:sql.includes('SELECT committed_start')?(mode==='missing'?[]:[{start,end:mode==='stale'?extended:end}])
      :sql.includes('SELECT id FROM public.planning_events')&&mode==='legacy'?[{id:'old'}]:[]}));
    await expect(applyRecoveryCommitmentsTx(tx,10,snapshot(),[],audit)).rejects.toMatchObject({code:'RECOVERY_EXTERNAL_PLAN_CHANGED'});
  });
  it('rejects another OF or a duplicated change before requesting any write',async()=>{
    for(const changes of [[{...change(),taskId:'op:other'}],[change(),change()]])
      await expect(applyRecoveryCommitmentsTx(tx,10,snapshot(),changes,audit)).rejects.toMatchObject({code:'RECOVERY_PLANNING_SCOPE'});
    expect(query).not.toHaveBeenCalled();
  });
  it('refuses to reopen a completed service',async()=>{
    await expect(applyRecoveryCommitmentsTx(tx,10,snapshot({...task(),commitment:'DONE'}),[change()],audit))
      .rejects.toMatchObject({code:'RECOVERY_OPERATION_CHANGED'});
  });
});
