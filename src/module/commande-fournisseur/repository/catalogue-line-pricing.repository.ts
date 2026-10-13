import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { priceCatalogueLine,type CataloguePriceSnapshot } from "../domain/catalogue-line-pricing";
import { catalogueBatchQuantities, catalogueQuantityKey, type CatalogueQuantityLine } from '../domain/catalogue-order-quantity';

export async function readCatalogueOrderQuantityTx(tx:Pick<PoolClient,"query">,orderId:string,line:CatalogueQuantityLine,excludeLineId:string|null=null){
  const row=(await tx.query<{quantity:number}>(`SELECT COALESCE(sum(GREATEST(l.quantite-COALESCE(l.qty_annulee,0),0)),0)::float8 AS quantity
    FROM public.commande_fournisseur_ligne l WHERE l.commande_id=$1::uuid AND l.statut_ligne='ACTIVE'
      AND l.catalogue_id=$2::uuid AND l.article_id IS NOT DISTINCT FROM $3::uuid AND l.unite IS NOT DISTINCT FROM $4::text
      AND ($5::uuid IS NULL OR l.id<>$5::uuid)`,[orderId,line.catalogue_id,line.article_id??null,line.unite??null,excludeLineId])).rows[0];
  return Number(row?.quantity??0)+line.quantite;
}

/** Recheck after draft edits/cancellations, under the existing order-header lock. */
export async function assertCatalogueMinimumsTx(tx:Pick<PoolClient,"query">,orderId:string){
  const lines=(await tx.query<CatalogueQuantityLine&{minimum:number|null}>(`SELECT l.catalogue_id::text,l.article_id::text,l.unite,
      GREATEST(l.quantite-COALESCE(l.qty_annulee,0),0)::float8 AS quantite,
      (CASE WHEN l.catalogue_pricing_snapshot IS NOT NULL THEN (l.catalogue_pricing_snapshot->>'moq')::numeric ELSE f.moq END)::float8 AS minimum
    FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id
    JOIN public.fournisseur_catalogue f ON f.id=l.catalogue_id AND f.fournisseur_id=c.fournisseur_id
    WHERE c.id=$1::uuid AND l.statut_ligne='ACTIVE'`,[orderId])).rows;
  const totals=catalogueBatchQuantities(lines);
  for(const line of lines){
    if(line.minimum!=null&&(totals.get(catalogueQuantityKey(line))??0)<Number(line.minimum))
      throw new HttpError(422,'CATALOGUE_MINIMUM_QUANTITY',`Le minimum de commande est ${line.minimum} ${line.unite}.`,
        {catalogue_id:line.catalogue_id,quantity:totals.get(catalogueQuantityKey(line)),minimum:Number(line.minimum)});
  }
}

export async function readCatalogueLinePriceTx(tx:Pick<PoolClient,"query">,orderId:string,line:CatalogueQuantityLine,context?:{orderQuantity?:number;excludeLineId?:string|null}){
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
  const orderQuantity=context?.orderQuantity??(snapshot.moq==null?line.quantite:await readCatalogueOrderQuantityTx(tx,orderId,line,context?.excludeLineId));
  return {snapshot,price:priceCatalogueLine(snapshot,line.quantite,orderQuantity)};
}
