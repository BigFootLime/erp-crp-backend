import {describe,it,expect} from 'vitest';
import {materialBalance,materialReservedCapacity,materialSelectionCoverage,proposeMaterialCoverage,type MaterialNeed,type MaterialLot} from './of-material';
import {materialSourceYields} from './material-source-yield';

const rule={form:'BAR' as const,stockUnit:'mm',unitsPerBlank:110,kerfPerBlank:.5,yieldValidated:true};
const held=(id:string,batch:string,qty:number)=>({id,stock_batch_id:batch,status:'ACTIVE',unexpired:true,qty_reserved:qty,qty_consumed:0});
const need:MaterialNeed={key:'need',articleId:'a',unit:'mm',required:2210,reserved:2210,consumed:0,expected:0,receivedBlocked:0,
  requirements:{grade:null,condition:null,ownerClientId:null,dimensions:{},certificates:[],manualChecks:[]},
  debitRule:rule,reservations:[held('r1','b1',2000),held('r2','b2',210)]};
const lot=(batchId:string,available:number):MaterialLot=>({id:batchId,batchId,articleId:'a',code:batchId,unit:'mm',quality:'LIBERE',available,receivedAt:batchId,
  grade:null,condition:null,ownerClientId:null,dimensions:{},certificates:[],manualVerified:false});

describe('whole blanks across material reservations (#1244)',()=>{
  it('detects 19 blanks instead of 20 in 2000 + 210 mm',()=>{
    expect(materialReservedCapacity(need)).toBe(2099.5);
    expect(materialBalance(need)).toMatchObject({reserved:2210,usableReserved:2099.5,missing:110.5});
  });
  it('proposes only 11 mm on the second source and does not duplicate the purchase',()=>{
    const result=proposeMaterialCoverage([need],[lot('b1',0),lot('b2',790)])[0];
    expect(result.selections).toEqual([{batchId:'b2',lotId:'b2',quantity:11}]);
    expect(result.purchaseMissing).toBe(0);
    expect(materialSelectionCoverage(need,result.selections)).toBe(110.5);
  });
  it('counts separate holds on the same batch once without pooling different batches',()=>{
    expect(materialReservedCapacity({...need,reservations:[...need.reservations!,held('topup','b2',11)]})).toBe(2210);
    expect(materialReservedCapacity({...need,reservations:[...need.reservations!,held('topup','b3',11)]})).toBe(2099.5);
  });
  it('allocates a new requirement as 1989 + 221 mm instead of 2000 + 210',()=>{
    const result=proposeMaterialCoverage([{...need,reserved:0,reservations:[]}],[lot('b1',2000),lot('b2',1000)])[0];
    expect(result.selections.map(s=>s.quantity)).toEqual([1989,221]);
    expect(result.purchaseMissing).toBe(0);
  });
  it('does not use expired, released or consumed holds as a top-up credit',()=>{
    for(const changed of [{unexpired:false},{status:'RELEASED'},{qty_consumed:210}]){
      const n={...need,reservations:[need.reservations![0],{...need.reservations![1],...changed}]};
      expect(materialReservedCapacity(n)).toBe(1989);
      expect(proposeMaterialCoverage([n],[lot('b2',790)])[0].selections[0].quantity).toBe(221);
    }
  });
  it('respects the shared stock pool and material origin cap for whole blanks',()=>{
    const fresh={...need,reserved:0,reservations:[]};
    const results=proposeMaterialCoverage([fresh,{...fresh,key:'other'}],[lot('b1',2000),lot('b2',1000)]);
    expect(results[0].purchaseMissing).toBe(0);
    expect(results[1].selections.map(s=>s.quantity)).toEqual([773.5]);
    const limited=proposeMaterialCoverage([fresh],[lot('b1',2000),lot('b2',1000)],{maximumLots:1,usedOrigins:new Set(),originsByLot:{b1:['heat1'],b2:['heat2']}})[0];
    expect(limited.purchaseMissing).toBe(221);
  });
  it('keeps quarantined material out of the proposed complement',()=>{
    expect(proposeMaterialCoverage([need],[{...lot('b2',790),quality:'QUARANTAINE'}])[0].purchaseMissing).toBe(110.5);
  });
  it('leaves unit and sheet balances unchanged',()=>{
    for(const form of ['UNIT','SHEET'] as const){
      const n={...need,debitRule:{...rule,form}};
      expect(materialBalance(n).missing).toBe(0);
      expect(materialSelectionCoverage(n,[{batchId:'b2',quantity:11}])).toBe(11);
    }
  });
  it('does not lose decimal precision at the whole-blank boundary',()=>{
    const n={...need,debitRule:{...rule,unitsPerBlank:.1,kerfPerBlank:.005},reservations:[held('r','b',.315)]};
    expect(materialReservedCapacity(n)).toBe(.315);
  });
  it('accepts one measured yield funded by two holds of the same physical source',()=>{
    const result=materialSourceYields({rule,good:2,scrap:0,sources:[
      {id:'r2',groupKey:'b2',quantity:210,yield:{good:2,scrap:0}},
      {id:'topup',groupKey:'b2',quantity:11,yield:{good:0,scrap:0}},
    ]});
    expect(result).toEqual([{id:'r2',good:2,scrap:0},{id:'topup',good:0,scrap:0}]);
  });
  it('refuses to mask a yield variance between distinct physical sources',()=>{
    expect(()=>materialSourceYields({rule,good:2,scrap:0,sources:[
      {id:'r2',groupKey:'b2',quantity:210,yield:{good:2,scrap:0}},
      {id:'topup',groupKey:'b3',quantity:11,yield:{good:0,scrap:0}},
    ]})).toThrow(/écarts de rendement/);
  });
});
