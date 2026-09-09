import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { consumablePurchaseQuantity } from '../../stock/domain/consumable-policy';

/** Rechecked after a buyer edits the draft or changes its supplier. */
export async function assertConsumableOrderReadyTx(tx:PoolClient,orderId:string){
  const lines=(await tx.query<{id:string;quantity:number;unit:string|null;stock_unit:string|null;coefficient:number|null;article_unit:string|null;article_pack:number;
    due:string|null;delay:number|null;catalogue_id:string|null;catalogue_unit:string|null;catalogue_stock_unit:string|null;catalogue_coefficient:number|null;minimum:number|null;pack:number|null}>(`
    SELECT l.id::text,l.quantite::float8 AS quantity,l.unite AS unit,l.unite_stock AS stock_unit,l.coef_conversion::float8 AS coefficient,
      a.unite AS article_unit,a.purchase_pack_qty::float8 AS article_pack,COALESCE(l.date_besoin,l.date_promesse,c.date_besoin,c.date_promesse)::text AS due,l.delai_jours AS delay,
      cat.id::text AS catalogue_id,cat.unite AS catalogue_unit,cat.unite_stock AS catalogue_stock_unit,cat.coef_conversion::float8 AS catalogue_coefficient,
      cat.moq::float8 AS minimum,cat.lot_achat::float8 AS pack
    FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id JOIN public.articles a ON a.id=l.article_id
    LEFT JOIN LATERAL(SELECT f.* FROM public.fournisseur_catalogue f WHERE f.article_id=a.id AND f.fournisseur_id=c.fournisseur_id AND f.actif
      AND(f.valid_from IS NULL OR f.valid_from<=current_date) AND(f.valid_to IS NULL OR f.valid_to>=current_date)
      AND(l.catalogue_id IS NULL OR f.id=l.catalogue_id) ORDER BY f.updated_at DESC,f.id LIMIT 1) cat ON true
    WHERE c.id=$1::uuid AND l.statut_ligne='ACTIVE' AND EXISTS(SELECT 1 FROM public.article_category_link ac WHERE ac.article_id=a.id AND ac.category_code='consommable')`,[orderId])).rows;
  for(const line of lines){
    if(!line.catalogue_id||line.unit!==line.catalogue_unit||(line.stock_unit??line.unit)!==line.article_unit||(line.catalogue_stock_unit??line.catalogue_unit)!==line.article_unit||(line.coefficient??1)!==(line.catalogue_coefficient??1))
      throw new HttpError(422,'CONSUMABLE_ORDER_CONDITIONS_REQUIRED','Confirmez les conditions du fournisseur choisi et la conversion de cette ligne consommable.',{line_id:line.id});
    const proposed=consumablePurchaseQuantity({shortage:line.quantity*(line.coefficient??1),articlePack:line.article_pack,supplierMinimum:line.minimum,supplierPack:line.pack,coefficient:line.coefficient??1});
    if(Math.abs(proposed.ordered-line.quantity)>0.000001)throw new HttpError(422,'CONSUMABLE_PURCHASE_PACK_REQUIRED','La quantité commandée doit respecter le minimum et les lots entiers du fournisseur.',{line_id:line.id,proposed_quantity:proposed.ordered});
    if(!line.due&&line.delay===null)throw new HttpError(422,'CONSUMABLE_PURCHASE_DELAY_REQUIRED','Confirmez une date ou un délai pour la ligne consommable.',{line_id:line.id});
  }
}
