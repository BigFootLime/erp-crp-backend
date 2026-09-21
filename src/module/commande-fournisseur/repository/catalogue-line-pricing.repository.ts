import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { priceCatalogueLine,type CataloguePriceSnapshot } from "../domain/catalogue-line-pricing";

export async function readCatalogueLinePriceTx(tx:Pick<PoolClient,"query">,orderId:string,line:{catalogue_id?:string|null;article_id?:string|null;unite?:string|null;quantite:number}){
  if(!line.catalogue_id)throw new HttpError(422,"CATALOGUE_REQUIRED","Sélectionnez une référence fournisseur.");
  const row=(await tx.query(`SELECT f.*,f.updated_at::text AS version,c.devise AS order_currency
    FROM public.fournisseur_catalogue f JOIN public.commande_fournisseur c ON c.fournisseur_id=f.fournisseur_id
    WHERE c.id=$1::uuid AND f.id=$2::uuid AND f.actif
      AND (f.valid_from IS NULL OR f.valid_from<=CURRENT_DATE) AND (f.valid_to IS NULL OR f.valid_to>=CURRENT_DATE)
    FOR SHARE OF f`,[orderId,line.catalogue_id])).rows[0];
  if(!row)throw new HttpError(422,"CATALOGUE_UNAVAILABLE","Cette référence fournisseur est inactive, expirée ou étrangère à la commande.");
  if(row.article_id!==line.article_id || row.unite!==line.unite || row.devise!==row.order_currency || Number(row.prix_multiple??1)!==1 ||
    (row.pricing_basis && row.pricing_basis!=="NONE" && row.pricing_basis.toLowerCase()!==String(line.unite).toLowerCase()))
    throw new HttpError(422,"CATALOGUE_UNIT_MISMATCH","La référence fournisseur doit correspondre à l’article, à l’unité, à la base de prix et à la devise de la ligne.");
  const snapshot:CataloguePriceSnapshot={catalogue_id:row.id,version:row.version,unit:row.unite,currency:row.devise,
    prix_unitaire:row.prix_unitaire==null?null:Number(row.prix_unitaire),forfait_ht:row.forfait_ht==null?null:Number(row.forfait_ht),
    minimum_facturation_ht:row.minimum_facturation_ht==null?null:Number(row.minimum_facturation_ht),moq:row.moq==null?null:Number(row.moq),price_tiers:row.price_tiers??[]};
  return {snapshot,price:priceCatalogueLine(snapshot,line.quantite)};
}
