import {describe,expect,it} from 'vitest';
import {computeSchedule} from './central-compute';
const fixture=()=>require('../../../../scripts/performance/planning-fixture.cjs').planningFixture({count:300});
describe('bounded calculation workers',()=>{
  it('cancels a queued or running calculation and recovers the worker slot',async()=>{
    const abort=new AbortController(),pending=computeSchedule(fixture(),abort.signal);
    abort.abort();await expect(pending).rejects.toMatchObject({code:'PLANNING_CANCELLED'});
    const result=await computeSchedule(fixture());expect(result.feasible).toBe(true);expect(result.changes).toHaveLength(300);
  });
  it('bounds queue admission and includes queue time in the deadline',async()=>{
    const jobs=Array.from({length:22},()=>computeSchedule(fixture(),undefined,1));
    const result=await Promise.allSettled(jobs);
    const codes=result.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason.code);
    expect(codes).toContain('PLANNING_BUSY');expect(codes).toContain('PLANNING_TIMEOUT');
    expect((await computeSchedule(fixture())).feasible).toBe(true);
  });
});
