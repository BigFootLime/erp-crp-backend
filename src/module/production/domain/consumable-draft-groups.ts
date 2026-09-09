import { consumablePurchaseQuantity } from '../../stock/domain/consumable-policy';
import { quantity } from './of-material';
import type { MaterialDraftLine } from '../../commande-fournisseur/repository/commande-fournisseur.repository';

export type ConsumableDraftRequest={line:MaterialDraftLine;shortage:number;articlePack:number;supplierPack:number|null;supplierMinimum:number|null};
/** Round after combining compatible net needs; keep each OF need's own allocation. */
export function groupConsumableDrafts(requests:ConsumableDraftRequest[]):MaterialDraftLine[]{
  const groups=new Map<string,ConsumableDraftRequest[]>();
  for(const request of requests){const l=request.line;
    const key=JSON.stringify([l.articleId,l.supplierId,l.catalogueId,l.destinationId,l.currency,l.unit,l.stockUnit,l.coefficient,l.price,l.due,l.delay,l.requirements,l.needId===null]);
    groups.set(key,[...(groups.get(key)??[]),request]);
  }
  return Array.from(groups.values(),group=>{
    const first=group[0],shortage=quantity(group.reduce((sum,r)=>sum+r.shortage,0));
    const purchase=consumablePurchaseQuantity({shortage,articlePack:first.articlePack,supplierPack:first.supplierPack,supplierMinimum:first.supplierMinimum,coefficient:first.line.coefficient??1});
    const allocations=group.flatMap(({line:l})=>l.needId&&l.ofId?[{needId:l.needId,sourceRef:l.sourceRef,ofId:l.ofId,assigned:l.assigned}]:[]);
    return {...first.line,quantity:purchase.ordered,assigned:quantity(allocations.reduce((sum,a)=>sum+a.assigned,0)),allocations};
  });
}
