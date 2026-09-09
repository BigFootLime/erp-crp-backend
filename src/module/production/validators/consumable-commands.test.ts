import { describe,expect,it } from 'vitest';
import { consumablePreparationSchema,consumableWithdrawalSchema } from './consumable-procurement.validators';
import { consumableReplenishmentSchema,consumableDepletionSchema } from '../../stock/validators/consumable-supply.validators';
import { confirmGroupedReceiptSchema } from '../../receptions/validators/grouped-receipts.validators';

const id='b869dd64-cad5-47bf-ab2c-23ec678b752f';
const command={idempotencyKey:id,expectedVersion:'version'};
describe('consumable command quantities',()=>{
  const schemas=[
    (quantity:number)=>consumableWithdrawalSchema.safeParse({...command,reservationId:id,reservationVersion:1,scan:'ART-CONS-1',reason:'Remis',quantity}),
    (quantity:number)=>consumablePreparationSchema.safeParse({...command,needs:[{key:id,reserve:false,purchase:true,future:[{lineId:id,quantity}]}]}),
    (quantity:number)=>consumableReplenishmentSchema.safeParse({...command,supplierId:id,destinationId:null,stockQuantity:quantity,existingPurchasesReviewed:true,reason:'Stock'}),
    (quantity:number)=>consumableDepletionSchema.safeParse({...command,lotId:id,scan:'Palette',expectedQuantity:quantity,reason:'Vide'}),
  ];
  it.each([0,-1,Infinity,NaN,0.0001,1000000000])('rejects invalid quantities %s before a stock write',quantity=>{
    for(const parse of schemas)expect(parse(quantity).success).toBe(false);
  });
  it.each([0.001,1,120.125,999999999])('accepts canonical precision %s',quantity=>{
    for(const parse of schemas)expect(parse(quantity).success).toBe(true);
  });
  it('rejects the same need twice in a preparation',()=>{
    const need={key:id,reserve:true,purchase:true};
    expect(consumablePreparationSchema.safeParse({...command,needs:[need,need]}).success).toBe(false);
  });
  it('rejects duplicate receipt lines and inconsistent pack totals',()=>{
    const line={lineId:id,expectedVersion:'v',quantity:100,destination:null,supplierLotCode:null,packs:[],overReceiptReason:null};
    expect(confirmGroupedReceiptSchema.safeParse({idempotencyKey:id,lines:[line,line]}).success).toBe(false);
    expect(confirmGroupedReceiptSchema.safeParse({idempotencyKey:id,lines:[{...line,packs:[{quantity:60,supplierLotCode:null}]}]}).success).toBe(false);
    expect(confirmGroupedReceiptSchema.safeParse({idempotencyKey:id,lines:[{...line,quantity:60}]}).success).toBe(true);
  });
});
