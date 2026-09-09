import { quantity } from "./of-material";
import { consumablePurchaseQuantity } from "../../stock/domain/consumable-policy";

export type ConsumableStockMode = "NONE" | "UNIT" | "GLOBAL_PACK";
/** Acceptance stays within its delivery interval when several OFs share an order line. */
export function acceptedReceiptInterval(start:number,assigned:number,receipts:Array<{quantity:number;accepted:number}>){
  let offset=0,received=0,accepted=0;
  for(const receipt of receipts){
    received+=Math.max(0,Math.min(start+assigned,offset+receipt.quantity)-Math.max(start,offset));
    accepted+=Math.max(0,Math.min(start+assigned,offset+receipt.accepted)-Math.max(start,offset));
    offset+=receipt.quantity;
  }
  return {received:quantity(received),accepted:quantity(accepted)};
}
export type ConsumableCommitment = {
  reserved:number; consumed:number; expected:number; receivedBlocked:number; receivedAccepted:number;
};
export function consumableCoverage(input:ConsumableCommitment & {
  mode:ConsumableStockMode; required:number; stockAvailable:number; availablePacks:number;
  articlePack:number; supplierPack?:number|null; supplierMinimum?:number|null; coefficient?:number;
  sharedExpected:number;
}) {
  const required=quantity(input.required);
  if(input.mode==="GLOBAL_PACK") {
    const available=input.availablePacks>0;
    return {required,shared:true,available,reserve:0,assigned:0,missing:0,
      replenishmentSuggested:!available&&input.sharedExpected<=0,
      purchase:consumablePurchaseQuantity({shortage:!available&&input.sharedExpected<=0?input.articlePack:0,
        articlePack:input.articlePack,supplierPack:input.supplierPack,supplierMinimum:input.supplierMinimum,coefficient:input.coefficient})};
  }
  const physical=input.mode==="NONE"?input.receivedAccepted:input.reserved+input.consumed;
  const remaining=quantity(Math.max(0,required-physical));
  const missing=quantity(Math.max(0,remaining-input.expected-input.receivedBlocked));
  const reserve=input.mode==="UNIT"?quantity(Math.min(missing,Math.max(0,input.stockAvailable))):0;
  const assigned=quantity(Math.max(0,missing-reserve));
  return {required,shared:false,available:remaining===0,reserve,assigned,missing,
    replenishmentSuggested:false,
    purchase:consumablePurchaseQuantity({shortage:assigned,articlePack:input.articlePack,
      supplierPack:input.supplierPack,supplierMinimum:input.supplierMinimum,coefficient:input.coefficient})};
}

/** FIFO selection shares each physical balance across needs within the same preview. */
export function selectConsumableStock<T extends {key:string;available:number}>(candidates:T[],needed:number,remaining:Map<string,number>) {
  let shortage=quantity(needed);
  const selections:Array<{candidate:T;quantity:number}>=[];
  for(const candidate of candidates){
    const available=remaining.get(candidate.key)??candidate.available;
    const selected=quantity(Math.min(shortage,Math.max(0,available)));
    if(selected>0){selections.push({candidate,quantity:selected});remaining.set(candidate.key,quantity(available-selected));shortage=quantity(shortage-selected);}
    if(shortage<=0)break;
  }
  return {selections,shortage};
}
