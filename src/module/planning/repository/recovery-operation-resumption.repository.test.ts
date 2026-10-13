import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {CentralSnapshot,CentralTask} from '../types/planning-central.types';
import type {AuditContext} from '../../production/repository/production.repository';
import {readRecoveryOperationResumptionsTx,resumeRecoveryOperationsTx} from './recovery-operation-resumption.repository';
const ended='2026-10-12T07:00:00Z',audit={user_id:8} as AuditContext;
const query=vi.fn(),tx={query} as unknown as PoolClient;
const task=()=>({id:'op:mill',operationId:'mill',ofId:10,source:'OPERATION',operationType:'FRAISAGE',commitment:'DONE',good:100,
  actual:{start:'2026-10-12T06:00:00Z',end:ended},committed:{start:'2026-10-12T06:00:00Z',end:ended}} as CentralTask);
const snapshot=(t=task())=>({tasks:[t,{...task(),ofId:20,id:'op:other'}]} as CentralSnapshot);
const previous={id:'mill',of_id:10,status:'DONE',ended_at:ended,temps_total_real:60};
const event={id:'old-slot',status:'DONE',start_ts:'2026-10-12T06:00:00Z',end_ts:ended,archived_at:null};
beforeEach(()=>{query.mockReset().mockImplementation(async(sql:string)=>({rows:sql.includes('to_jsonb(op) AS before')?[{before:previous,busy:false}]
  :sql.includes('to_jsonb(e)')?[{saved:event}]:sql.includes('to_jsonb(t)')?[{saved:{id:'op:mill'}}]:[],rowCount:1}));});
describe('completed operation cycle preservation',()=>{
  it('captures the exact operation and slots, then reopens only the authorized current cycle',async()=>{
    const original=snapshot(),before=structuredClone(original),proof=await readRecoveryOperationResumptionsTx(tx,10,original);
    expect(proof).toEqual([{operation_id:'mill',task_id:'op:mill',before:previous,planning_events:[event],planning_task:{id:'op:mill'}}]);
    expect(query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
    const effective=await resumeRecoveryOperationsTx(tx,original,proof,audit);
    expect(effective.tasks[0]).toMatchObject({commitment:'COMMITTED',actual:null,committed:null,good:100});
    expect(effective.tasks[1]).toEqual(original.tasks[1]);expect(original).toEqual(before);
    const writes=query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE'));
    expect(writes).toHaveLength(2);expect(writes[0][0]).not.toContain("status='CANCELLED'");
    expect(writes[1][1]).toEqual(['mill',JSON.stringify(previous)]);
    expect(writes.some(([sql])=>sql.includes('production_quantity_declarations')||sql.includes('of_time_logs')||sql.includes('production_pointages'))).toBe(false);
  });
  it('never reopens cutting even with a matching historical proof',async()=>{
    await expect(readRecoveryOperationResumptionsTx(tx,10,snapshot({...task(),operationType:'DECOUPE'})))
      .rejects.toMatchObject({code:'RECOVERY_COMPLETION_CHANGED'});expect(query).not.toHaveBeenCalled();
  });
  it.each(['busy','timestamp'] as const)('refuses a changed completion: %s',async mode=>{
    query.mockResolvedValue({rows:[{before:{...previous,ended_at:mode==='timestamp'?'2026-10-12T07:01:00Z':ended},busy:mode==='busy'}]});
    await expect(readRecoveryOperationResumptionsTx(tx,10,snapshot())).rejects.toMatchObject({code:'RECOVERY_COMPLETION_CHANGED'});
  });
  it('refuses missing or split historical commitments for a completed external service',async()=>{
    await expect(readRecoveryOperationResumptionsTx(tx,10,snapshot({...task(),external:{} as CentralTask['external']})))
      .rejects.toMatchObject({code:'RECOVERY_COMPLETION_CHANGED'});
  });
  it('fails atomically if the completed operation or archived slot changed',async()=>{
    const proof=await readRecoveryOperationResumptionsTx(tx,10,snapshot());
    for(const failedTable of ['planning_events','of_operations']) {
      query.mockImplementation(async(sql:string)=>({rows:[],rowCount:sql.includes(failedTable)?0:1}));
      await expect(resumeRecoveryOperationsTx(tx,snapshot(),proof,audit)).rejects.toMatchObject({status:409});
    }
  });
});
