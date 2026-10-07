import {describe,it,expect} from 'vitest';
import {materialPurchasePreparations,consumablePurchasePreparations,purchaseScopeKey} from './purchase-preparation';

const identity={ofId:91,technicalVersion:'version-a',technicalHash:'hash-a'};
const material={key:'purchase-a',id:null,articleId:'article-a',designation:'Brut',unit:'mm',supplyMode:'PURCHASE' as const,
  required:11000,purchaseMissing:2200,blockers:[],supplierId:null,destinationId:null,price:null,operationId:'op-a',operationLabel:'Découpe',
  requirements:{grade:'42CrMo4',condition:null,ownerClientId:null,dimensions:{diametre_mm:35},certificates:['3.1'],manualChecks:[]},futureSupplies:[]};
describe('supplierless purchase preparation',()=>{
  it('keeps a stable identity when stock, supplier or price changes, but separates technical revisions',()=>{
    const a=materialPurchasePreparations({...identity,needs:[material],previousNeeds:[],operations:[]})[0];
    const b=materialPurchasePreparations({...identity,needs:[{...material,purchaseMissing:100,supplierId:'supplier-a',price:2}],previousNeeds:[],operations:[]})[0];
    expect(a.scopeKey).toBe(b.scopeKey);
    expect(a.scopeKey).not.toBe(purchaseScopeKey({...identity,technicalHash:'hash-b'},'MATIERE',material.key));
    expect(a).toMatchObject({missing:2200,ordered:2200,status:'A_COMPLETER',supplierId:null,requirements:material.requirements});
  });
  it('preserves unreliable quantities as unknown and excludes customer material',()=>{
    const input={...identity,needs:[{...material,blockers:['Confirmer la conversion.']}],previousNeeds:[],operations:[]};
    expect(materialPurchasePreparations(input)[0]).toMatchObject({missing:null,ordered:null,status:'A_COMPLETER'});
    expect(materialPurchasePreparations({...input,needs:[{...material,supplyMode:'CUSTOMER'}]})).toEqual([]);
  });
  it('requires examination of an existing unallocated purchase before a new request',()=>{
    const result=materialPurchasePreparations({...identity,needs:[{...material,supplierId:'supplier-a',price:2,
      futureSupplies:[{id:'line-a',code:'CF-A',available:3000,reasons:[]}]}],previousNeeds:[],operations:[]})[0];
    expect(result.status).toBe('A_COMPLETER');expect(result.futurePurchases).toHaveLength(1);
    expect(result.actions.join(' ')).toContain('achats attendus');
  });
  it('shares one global pack request across OFs while keeping production consumables separate',()=>{
    const need={key:'global-a',id:null,articleId:'article-a',designation:'Cartons',unit:'u',mode:'GLOBAL_PACK' as const,
      required:20,assigned:0,articlePack:100,purchase:{assigned:100,ordered:1},blockers:[],supplierId:null,destinationId:null,
      catalogue:{price:null,unit:'palette'},futureSupplies:[]};
    const a=consumablePurchasePreparations({...identity,needs:[need,{...need,key:'global-b'}],previousNeeds:[]});
    const b=consumablePurchasePreparations({...identity,ofId:92,needs:[{...need,key:'global-c'}],previousNeeds:[]});
    expect(a).toHaveLength(1);expect(a[0].scopeKey).toBe(b[0].scopeKey);
    expect(a[0]).toMatchObject({ofId:null,needId:null,sourceRef:null,missing:100,ordered:100,purchaseUnit:'u'});
    const unitA=consumablePurchasePreparations({...identity,needs:[{...need,mode:'UNIT'}],previousNeeds:[]})[0];
    const unitB=consumablePurchasePreparations({...identity,ofId:92,needs:[{...need,mode:'UNIT'}],previousNeeds:[]})[0];
    expect(unitA.scopeKey).not.toBe(unitB.scopeKey);
    expect(unitA.purchaseUnit).toBe('palette');
  });
});
