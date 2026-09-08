import {expect,it} from 'vitest';
import {materialCarryBlockers,type ReconciliationIdentity} from './material-reconciliation';
const identity:ReconciliationIdentity={articleId:'alu',unit:'u',supplyMode:'CUSTOMER',requirements:{grade:'6082',condition:'T651',ownerClientId:'client',dimensions:{longueur_mm:85},certificates:['3.1'],manualChecks:[]},debitRule:{form:'UNIT',stockUnit:'u',unitsPerBlank:1,kerfPerBlank:0,yieldValidated:true},operationId:'cut',consumed:0};
it('carries unchanged specifications to a new operation before any consumption',()=>expect(materialCarryBlockers(identity,{...identity,operationId:'new-cut'})).toEqual([]));
it('compares JSONB specifications by content despite object key order',()=>{
  const reordered={...identity,requirements:Object.fromEntries(Object.entries(identity.requirements).reverse()) as typeof identity.requirements};
  expect(materialCarryBlockers(identity,reordered)).toEqual([]);
});
it('never reuses another article, unit or client property implicitly',()=>{
  for(const target of [{...identity,articleId:'steel'},{...identity,unit:'m'},{...identity,requirements:{...identity.requirements,ownerClientId:'other'}}])expect(materialCarryBlockers(identity,target)).not.toEqual([]);
});
it('preserves the specification purchased and requires review of changed certificates',()=>expect(materialCarryBlockers(identity,{...identity,requirements:{...identity.requirements,certificates:['3.2']}})).not.toEqual([]));
it('keeps consumed quantity attached to the same operation and conversion',()=>{
  const old={...identity,consumed:20};expect(materialCarryBlockers(old,identity)).toEqual([]);
  expect(materialCarryBlockers(old,{...identity,operationId:'other'})).not.toEqual([]);
  expect(materialCarryBlockers(old,{...identity,debitRule:{...identity.debitRule!,unitsPerBlank:2}})).not.toEqual([]);
});
