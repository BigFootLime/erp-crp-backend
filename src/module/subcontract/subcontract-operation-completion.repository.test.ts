import {describe,it,expect,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {syncClosedSubcontractOperationTx} from './subcontract-operation-completion.repository';

describe('external completion preserves revision and legacy scopes',()=>{
  const base={active:true,status:'TODO',kind:'SOUS_TRAITANCE',target:20};
  it.each([null,{...base,active:false},{...base,kind:'ASSEMBLAGE'},{...base,status:'CANCELLED'},{...base,status:'BLOCKED'}])('does not write for ineligible canonical scope %j',async row=>{
    const query=vi.fn(async()=>({rows:row?[row]:[]}));
    expect(await syncClosedSubcontractOperationTx({query} as unknown as PoolClient,'operation',1)).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('keeps prior evidence and performs no second mutation',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[base]}).mockResolvedValueOnce({rows:[{id:'proof'}]});
    expect(await syncClosedSubcontractOperationTx({query} as unknown as PoolClient,'operation',1)).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some(([sql])=>/\b(INSERT|UPDATE|DELETE)\b/.test(sql.replace('FOR UPDATE','')))).toBe(false);
  });
  it('requires explicit review instead of overwriting compensated legacy output',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[base]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{id:'legacy'}]});
    expect(await syncClosedSubcontractOperationTx({query} as unknown as PoolClient,'operation',1)).toBe(false);
    expect(query).toHaveBeenCalledTimes(3);
  });
});
