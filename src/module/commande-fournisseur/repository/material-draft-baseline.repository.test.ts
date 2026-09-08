import {describe,expect,it,vi} from 'vitest';
import {findUntouchedMaterialDraftTx,recordMaterialDraftBaselineTx} from './material-draft-baseline.repository';
describe('untouched purchase drafts',()=>{
  it('skips the buyer-edited draft before choosing an untouched compatible draft',async()=>{
    const tx={query:vi.fn().mockResolvedValueOnce({rows:[{id:'edited',code:'BCF-1'},{id:'untouched',code:'BCF-2'}]})
      .mockResolvedValueOnce({rows:[{unchanged:false}]}).mockResolvedValueOnce({rows:[{unchanged:true}]})};
    expect(await findUntouchedMaterialDraftTx(tx as never,{supplierId:'supplier',currency:'EUR',destinationId:'warehouse'})).toEqual({id:'untouched',code:'BCF-2'});
    expect(tx.query.mock.calls[0][1]).toEqual(['supplier','EUR','warehouse']);
    expect(tx.query.mock.calls[0][0]).toContain('FOR UPDATE OF c');
    expect(tx.query.mock.calls[0][0]).toContain('supplier_consultations');
  });
  it('creates no permission to modify a buyer-edited draft',async()=>{
    const tx={query:vi.fn().mockResolvedValueOnce({rows:[{id:'edited',code:'BCF-1'}]}).mockResolvedValueOnce({rows:[{unchanged:false}]})};
    expect(await findUntouchedMaterialDraftTx(tx as never,{supplierId:'supplier',currency:'EUR',destinationId:null})).toBeNull();
    expect(tx.query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
  });
  it('captures the header, all lines and allocations in the same caller transaction',async()=>{
    const tx={query:vi.fn().mockResolvedValue({rows:[]})};await recordMaterialDraftBaselineTx(tx as never,'draft');
    expect(tx.query.mock.calls[0][0]).toContain("'header',to_jsonb(c)");
    expect(tx.query.mock.calls[0][0]).toContain("'allocations'");
    expect(tx.query.mock.calls[0][1]).toEqual(['draft']);
    expect(tx.query).toHaveBeenCalledTimes(1);
  });
});
