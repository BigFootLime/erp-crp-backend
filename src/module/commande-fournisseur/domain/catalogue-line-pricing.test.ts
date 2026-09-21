import { describe,it,expect } from "vitest";
import { priceCatalogueLine,changesCataloguePricing,type CataloguePriceSnapshot } from "./catalogue-line-pricing";
import { computeLigneTotaux } from "./commande-fournisseur-totaux";
import { supplierPriceTiersSchema } from "../../fournisseurs/validators/supplier-price-tiers";
const offer:CataloguePriceSnapshot={catalogue_id:"id",version:"v1",currency:"EUR",unit:"u",prix_unitaire:10,forfait_ht:20,minimum_facturation_ht:100,moq:2,
  price_tiers:[{qty_min:10,qty_max:100,unit_price:8},{qty_min:100,qty_max:null,unit_price:6}]};
describe("tarification du flux fournisseur",()=>{
  it("garde le tarif figé quand un formulaire renvoie les mêmes prix avec une nouvelle quantité",()=>{
    const initial={quantite:2,prix_unitaire_ht:10,frais_ht:80,remise_pct:0,unite:"u"};
    expect(changesCataloguePricing(initial,{...initial,quantite:100})).toBe(false);
    expect(priceCatalogueLine(offer,100).net_ht).toBe(620);
    expect(changesCataloguePricing(initial,{prix_unitaire_ht:9})).toBe(true);
    expect(changesCataloguePricing(initial,{unite:"kg"})).toBe(true);
    expect(changesCataloguePricing(initial,{apply_catalogue_pricing:false})).toBe(true);
  });
  it.each([[2,10,80,100],[10,8,20,100],[100,6,20,620],[9.5,10,20,115]])("quantité %s : palier et minimum sont conservés dans les totaux",(quantity,unit,fees,total)=>{
    const priced=priceCatalogueLine(offer,quantity);
    expect(priced).toEqual({prix_unitaire_ht:unit,frais_ht:fees,remise_pct:0,net_ht:total});
    expect(computeLigneTotaux({...priced,quantite:quantity,tva_pct:20}).net_ht).toBe(total);
  });
  it("refuse un prix inconnu et une quantité sous le minimum",()=>{
    expect(()=>priceCatalogueLine(offer,1)).toThrow();
    expect(()=>priceCatalogueLine({...offer,prix_unitaire:null},2)).toThrow();
  });
  it("accepte le prix zéro confirmé et arrondit au centime sans fausser le minimum",()=>{
    expect(priceCatalogueLine({...offer,prix_unitaire:0,forfait_ht:0,minimum_facturation_ht:0},2).net_ht).toBe(0);
    const priced=priceCatalogueLine({...offer,prix_unitaire:0.3333,forfait_ht:0.015,minimum_facturation_ht:0},3);
    expect(priced.net_ht).toBe(1.01);expect(computeLigneTotaux({...priced,quantite:3,tva_pct:20}).net_ht).toBe(1.01);
  });
  it("refuse les bornes inversées et les chevauchements, y compris un palier ouvert",()=>{
    for(const tiers of [[{qty_min:10,qty_max:2,unit_price:1}], [{qty_min:0,qty_max:null,unit_price:1},{qty_min:10,qty_max:20,unit_price:2}],
      [{qty_min:0,qty_max:10,unit_price:1},{qty_min:9,qty_max:20,unit_price:2}]])expect(supplierPriceTiersSchema.safeParse(tiers).success).toBe(false);
  });
});
