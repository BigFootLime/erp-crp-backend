import {describe,expect,it} from 'vitest';
import {compareDirectories} from './directory-reconciliation';
const account=(id:number,username='ALICE',email:string|null='alice@example.test')=>({id,username,email});
describe('shared directory read-only reconciliation',()=>{
  it('never equates different identities sharing a local integer ID',()=>{
    const result=compareDirectories([account(7)],[account(7,'BOB','bob@example.test')]);
    expect(result.same_id_different_identity).toBe(1);expect(result.matching_identities).toBe(0);expect(result.ready_for_automatic_reconciliation).toBe(false);
  });
  it('recognizes identity spelling but reports foreign-key remapping',()=>{
    const result=compareDirectories([account(7)],[account(45,' alice ',' ALICE@example.test ')]);
    expect(result.matching_identities).toBe(1);expect(result.matching_identity_different_id).toBe(1);expect(result.same_id_different_identity).toBe(0);
  });
  it('does not automatically merge identities with matching IDs or credentials',()=>{
    expect(compareDirectories([account(7)],[account(7)]).ready_for_automatic_reconciliation).toBe(false);
  });
  it('rejects missing-email and duplicate identity ambiguity',()=>{
    const result=compareDirectories([account(7),account(8),account(9,'UNKNOWN',null)],[account(10)]);
    expect(result.ambiguous_identities).toBe(2);expect(result.matching_identities).toBe(0);
  });
  it('contains only aggregate counts, never personally identifiable fields',()=>{
    const serialized=JSON.stringify(compareDirectories([account(7)],[account(45)]));
    expect(serialized).not.toContain('ALICE');expect(serialized).not.toContain('example.test');
  });
});
