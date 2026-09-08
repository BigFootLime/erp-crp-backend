import {describe,expect,it} from 'vitest';
import {assertJustifiedSelfRelease,assertDerogationApprovalSeparation} from './quality-policy';

describe('justified self release, approved policy #767',()=>{
  const own={executorUserId:7,deciderUserId:7,isSuperadmin:true,justification:'Mesures et exigences vérifiées avant libération.'};
  it('admits a justified current superuser',()=>expect(assertJustifiedSelfRelease(own)).toBe(true));
  it('denies an ordinary or revoked account even with a reason',()=>{
    expect(()=>assertJustifiedSelfRelease({...own,isSuperadmin:false})).toThrow(/ne peut pas/);
  });
  it.each([null,undefined,'','         ','conforme'])('requires an explicit reason (%s)',justification=>{
    expect(()=>assertJustifiedSelfRelease({...own,justification})).toThrow(/10 caractères/);
  });
  it('retains a second-person decision without an invented justification',()=>{
    expect(assertJustifiedSelfRelease({...own,deciderUserId:8,isSuperadmin:false,justification:null})).toBe(false);
  });
  it('does not authorize approving one’s own derogation',()=>{
    expect(()=>assertDerogationApprovalSeparation({requesterUserId:7,approverUserId:7})).toThrow();
  });
});
