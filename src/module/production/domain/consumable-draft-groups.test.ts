import {describe,it,expect} from 'vitest';
import {groupConsumableDrafts,type ConsumableDraftRequest} from './consumable-draft-groups';
function need(id:string,shortage:number,changes:Partial<ConsumableDraftRequest['line']>={}):ConsumableDraftRequest{return {shortage,articlePack:100,supplierPack:100,supplierMinimum:null,line:{needId:id,ofId:1,sourceRef:id,articleId:'article',designation:'Consommable',supplierId:'supplier',catalogueId:'catalogue',currency:'EUR',destinationId:'store',unit:'u',stockUnit:'u',coefficient:1,price:2,due:null,quantity:100,assigned:shortage,requirements:[],operation:'Consommable OF',...changes}};}
describe('net consumable purchase grouping',()=>{
  it('buys one pack for two needs of 40 and retains both identities',()=>{const result=groupConsumableDrafts([need('a',40),need('b',40)]);expect(result).toHaveLength(1);expect(result[0]).toMatchObject({quantity:100,assigned:80,allocations:[{needId:'a',assigned:40},{needId:'b',assigned:40}]});});
  it('rounds aggregate 120 to 200 without assigning surplus',()=>{expect(groupConsumableDrafts([need('a',30),need('b',90)])[0]).toMatchObject({quantity:200,assigned:120});});
  it('keeps destinations and suppliers separate',()=>{expect(groupConsumableDrafts([need('a',30),need('b',30,{destinationId:'other'}),need('c',30,{supplierId:'other'})])).toHaveLength(3);});
  it('respects purchase conversion and never assigns shared pallets',()=>{const request=need('a',120,{needId:null,ofId:null,unit:'palette',coefficient:100,assigned:0});request.supplierPack=1;expect(groupConsumableDrafts([request])[0]).toMatchObject({quantity:2,assigned:0,allocations:[]});});
});
