import { describe, expect, it, vi } from 'vitest';
import { createMaterialBarPostingOwner, consumeMaterialBarPostingOwner } from './material-bar-posting-owner';

const tx = { query: vi.fn() };
const expected = { movementId: 'movement', batchId: 'batch', type: 'IN' as const, quantityMm: 3000 };
const actual = { id: 'movement', batchId: 'batch', type: 'IN', quantity: 3000, reversalOf: null };
describe('server-owned material posting capability', () => {
  it('allows exactly the prepared movement once', () => {
    const owner=createMaterialBarPostingOwner(tx,'RECEIPT',expected);
    expect(()=>consumeMaterialBarPostingOwner(tx,owner,actual)).not.toThrow();
    expect(()=>consumeMaterialBarPostingOwner(tx,owner,actual)).toThrow(expect.objectContaining({code:'MATERIAL_BAR_POST_OWNER_INVALID'}));
  });
  it('rejects a JSON copy or forged capability', () => {
    const owner=createMaterialBarPostingOwner(tx,'RECEIPT',expected);
    for(const forged of [{kind:'RECEIPT' as const},JSON.parse(JSON.stringify(owner))])
      expect(()=>consumeMaterialBarPostingOwner(tx,forged,actual)).toThrow(expect.objectContaining({code:'MATERIAL_BAR_POST_OWNER_INVALID'}));
  });
  it('binds the owner to the transaction client', () => {
    const owner=createMaterialBarPostingOwner(tx,'RECEIPT',expected);
    expect(()=>consumeMaterialBarPostingOwner({query:vi.fn()},owner,actual)).toThrow();
  });
  it.each([{id:'other'},{batchId:'other'},{type:'OUT'},{quantity:2999},{quantity:0},{quantity:NaN},{reversalOf:'other'}])('rejects a different canonical post: %j', delta => {
    expect(()=>consumeMaterialBarPostingOwner(tx,createMaterialBarPostingOwner(tx,'RECEIPT',expected),{...actual,...delta})).toThrow();
  });
  it('requires the exact original debit on a correction', () => {
    const owner=createMaterialBarPostingOwner(tx,'CORRECTION',{...expected,correctionOf:'original'});
    expect(()=>consumeMaterialBarPostingOwner(tx,owner,actual)).toThrow();
    expect(()=>consumeMaterialBarPostingOwner(tx,owner,{...actual,reversalOf:'original'})).not.toThrow();
  });
});
