import { HttpError } from "../../../utils/httpError";
import { supplierPriceTiersSchema, type SupplierPriceTier } from "../../fournisseurs/validators/supplier-price-tiers";
import { roundMoney } from "./commande-fournisseur-totaux";

export type CataloguePriceSnapshot={catalogue_id:string;version:string;unit:string;currency:string;
  prix_unitaire:number|null;forfait_ht:number|null;minimum_facturation_ht:number|null;moq:number|null;price_tiers:SupplierPriceTier[]};

/** Full-form submissions may resend unchanged prices while only quantity changes. */
export function changesCataloguePricing(existing:Record<string,unknown>,patch:Record<string,unknown>) {
  return patch.apply_catalogue_pricing===false ||
    ['prix_unitaire_ht','frais_ht','remise_pct','catalogue_id','article_id','unite','unite_stock','coef_conversion','type']
      .some(key=>key in patch && patch[key]!==existing[key]);
}

/** Rule confirmed by the business: max(quantity × price + flat fee, minimum). */
export function priceCatalogueLine(snapshot:CataloguePriceSnapshot,quantity:number) {
  if(!Number.isFinite(quantity)||quantity<=0)throw new HttpError(422,"INVALID_QUANTITY","La quantité doit être positive.");
  if(snapshot.moq!=null&&quantity<snapshot.moq)throw new HttpError(422,"CATALOGUE_MINIMUM_QUANTITY",`Le minimum de commande est ${snapshot.moq} ${snapshot.unit}.`);
  const tier=supplierPriceTiersSchema.parse(snapshot.price_tiers).find(t=>quantity>=t.qty_min&&(t.qty_max===null||quantity<t.qty_max));
  const price=tier?.unit_price??snapshot.prix_unitaire;
  if(price===null||!Number.isFinite(price)||price<0)throw new HttpError(422,"CATALOGUE_PRICE_MISSING","Le prix n’est pas renseigné pour cette quantité.");
  const total=roundMoney(Math.max(quantity*price+(snapshot.forfait_ht??0),snapshot.minimum_facturation_ht??0));
  // Existing order accounting stores all additional charges in frais_ht.
  return {prix_unitaire_ht:price,frais_ht:roundMoney(total-roundMoney(quantity*price)),remise_pct:0,net_ht:total};
}
