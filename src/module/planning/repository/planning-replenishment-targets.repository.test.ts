import { describe,expect,it,vi } from 'vitest';
import {earliestReplenishmentTarget,readReplenishmentPlanningTargets,REPLENISHMENT_PLANNING_TARGETS_SQL} from './planning-replenishment-targets.repository';

describe('anticipated targets are distinct from estimated finishes',()=>{
  it('reads original targets on the caller transaction, deduplicating OFs',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{installed:true}]}).mockResolvedValueOnce({rows:[{of_id:'94',target_date:'2026-09-30'}]});
    expect(await readReplenishmentPlanningTargets({query},[94,94])).toEqual(new Map([[94,'2026-09-30']]));
    expect(query).toHaveBeenLastCalledWith(REPLENISHMENT_PLANNING_TARGETS_SQL,[[94]]);
    expect(query.mock.calls.some(([sql])=>/\b(?:UPDATE|INSERT|DELETE)\b/.test(sql))).toBe(false);
  });
  it('keeps existing planning readable before migration and does not query absent roots',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{installed:false}]});
    expect(await readReplenishmentPlanningTargets({query},[94])).toEqual(new Map());expect(query).toHaveBeenCalledTimes(1);
  });
  it('does no database work for an empty scope',async()=>{
    const query=vi.fn();expect(await readReplenishmentPlanningTargets({query},[])).toEqual(new Map());expect(query).not.toHaveBeenCalled();
  });
  it('rejects unsafe and excessive IDs before database work',async()=>{
    const query=vi.fn();for(const ids of [[0],[-1],[1.5],[Number.MAX_SAFE_INTEGER+1],Array(10001).fill(94)])
      await expect(readReplenishmentPlanningTargets({query},ids)).rejects.toMatchObject({status:422,code:'CONTRACT_REPLENISHMENT_TARGET_SCOPE_INVALID'});
    expect(query).not.toHaveBeenCalled();
  });
  it('does not hide a database failure behind an empty target map',async()=>{
    const error=new Error('read failed'),query=vi.fn().mockRejectedValue(error);
    await expect(readReplenishmentPlanningTargets({query},[94])).rejects.toBe(error);
  });
  it('preserves the original overdue target when a later commercial need exists',()=>{
    expect(earliestReplenishmentTarget('2026-10-31','2026-09-30')).toBe('2026-09-30');
    expect(earliestReplenishmentTarget(null,'2026-09-30')).toBe('2026-09-30');
  });
  it('preserves an earlier commercial deadline',()=>{
    expect(earliestReplenishmentTarget('2026-09-15','2026-09-30')).toBe('2026-09-15');
  });
});
