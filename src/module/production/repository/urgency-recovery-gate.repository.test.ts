import { describe, expect, it, vi } from 'vitest';
import { assertUrgencyRecoveryStartTx } from './urgency-recovery-gate.repository';
describe('recovery execution gate',()=>{
  it.each(['WAITING_PLANNER','CANCELLED'])('blocks execution while the recovery request is %s',async status=>{
    const tx={query:vi.fn().mockResolvedValue({rows:[{id:'request',status}]})};
    await expect(assertUrgencyRecoveryStartTx(tx,101)).rejects.toMatchObject({status:409,code:'URGENCY_RECOVERY_NOT_APPROVED'});
  });
  it('leaves an ordinary OF to the canonical production readiness rules',async()=>{
    await expect(assertUrgencyRecoveryStartTx({query:vi.fn().mockResolvedValue({rows:[]})},101)).resolves.toBeUndefined();
  });
});
