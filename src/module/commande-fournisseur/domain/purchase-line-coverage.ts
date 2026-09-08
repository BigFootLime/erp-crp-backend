import {HttpError} from '../../../utils/httpError';

export type AllocatedPurchaseLine={type:string;article_id:string|null;unite:string|null;unite_stock:string|null;coef_conversion:number|null;quantite:number;qty_annulee:number};
/** Material allocations use stock units; the purchase owner supplies their
 * normalized total. Changing commercial conditions cannot erase a promise. */
export function assertPurchaseLineCoveragePatch(current:AllocatedPurchaseLine,patch:Partial<AllocatedPurchaseLine>,allocatedStockQty:number){
  if(allocatedStockQty<=0)return;
  for(const field of ['type','article_id','unite','unite_stock','coef_conversion'] as const){
    if(field in patch&&patch[field]!==current[field])throw new HttpError(409,'PURCHASE_ALLOCATED_IDENTITY_CHANGE','Cette ligne couvre déjà des besoins. Révisez les affectations avant de changer son article ou sa conversion.');
  }
  const ordered=patch.quantite??current.quantite;
  const stockQuantity=(ordered-current.qty_annulee)*(current.coef_conversion??1);
  if(stockQuantity+0.0000001<allocatedStockQty)throw new HttpError(409,'PURCHASE_BELOW_ALLOCATED_QUANTITY','La quantité commandée ne peut pas être inférieure aux besoins déjà affectés.',{minimumPurchaseQty:allocatedStockQty/(current.coef_conversion??1)+current.qty_annulee,unit:current.unite});
}
