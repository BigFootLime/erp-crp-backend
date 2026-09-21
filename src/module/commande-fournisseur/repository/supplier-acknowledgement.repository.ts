import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { repoUpdateFournisseurCatalogueItem } from "../../fournisseurs/repository/fournisseurs.repository";
import { supplierPriceTiersSchema } from "../../fournisseurs/validators/supplier-price-tiers";
import type { AccuseBodyDTO } from "../validators/commande-fournisseur.validators";
import type { AuditContext } from "./commande-fournisseur.repository";

/** Runs under the locked order header, in the same transaction as the AR. */
export async function applyAcknowledgementPricesTx(tx:PoolClient,orderId:string,lines:AccuseBodyDTO["lignes"],audit:AuditContext) {
  const changes:unknown[]=[];
  const updatedCatalogues=new Set<string>();
  for(const input of [...(lines??[])].sort((a,b)=>a.ligne_id.localeCompare(b.ligne_id))){
    const line=(await tx.query(`SELECT l.id,l.catalogue_id,l.article_id,l.unite,l.quantite::float8,
      l.prix_unitaire_ht::float8,l.frais_ht::float8,c.fournisseur_id,c.devise
      FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id
      WHERE l.id=$1::uuid AND l.commande_id=$2::uuid AND l.statut_ligne='ACTIVE' FOR UPDATE OF l`,[input.ligne_id,orderId])).rows[0];
    if(!line)throw new HttpError(409,"AR_LINE_CHANGED","Une ligne n’appartient plus aux lignes actives de cette commande.");
    let catalogueChange:unknown=null;
    if(input.update_catalogue){
      if(!line.catalogue_id)throw new HttpError(422,"AR_CATALOGUE_REQUIRED","Rattachez une référence fournisseur avant de mettre à jour son prix.");
      if(updatedCatalogues.has(line.catalogue_id))throw new HttpError(422,"AR_CATALOGUE_AMBIGUOUS","Confirmez une seule mise à jour par référence fournisseur dans cet AR.");
      updatedCatalogues.add(line.catalogue_id);
      const catalogue=(await tx.query(`SELECT *,updated_at::text AS version FROM public.fournisseur_catalogue
        WHERE id=$1::uuid AND fournisseur_id=$2::uuid AND article_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
        [line.catalogue_id,line.fournisseur_id,line.article_id])).rows[0];
      if(!catalogue || !catalogue.actif || catalogue.version!==input.expected_catalogue_updated_at)
        throw new HttpError(409,"AR_CATALOGUE_CHANGED","Les conditions fournisseur ont changé. Actualisez la commande avant de confirmer l’AR.");
      if(catalogue.unite!==line.unite || catalogue.devise!==line.devise || Number(catalogue.prix_multiple??1)!==1 ||
        (catalogue.pricing_basis && catalogue.pricing_basis!=="NONE" && catalogue.pricing_basis.toLowerCase()!==String(line.unite).toLowerCase()))
        throw new HttpError(422,"AR_PRICE_UNIT_MISMATCH","Le prix catalogue et le prix commandé doivent avoir la même unité, base de prix et devise.");
      const tiers=supplierPriceTiersSchema.parse(catalogue.price_tiers??[]);
      const index=tiers.findIndex(t=>line.quantite>=t.qty_min && (t.qty_max===null || line.quantite<t.qty_max));
      const patch=index<0?{prix_unitaire:input.prix_unitaire_ht}:{price_tiers:tiers.map((t,i)=>i===index?{...t,unit_price:input.prix_unitaire_ht}:t)};
      const saved=await repoUpdateFournisseurCatalogueItem(line.fournisseur_id,line.catalogue_id,patch,audit,tx);
      if(!saved)throw new HttpError(409,"AR_CATALOGUE_CHANGED","La référence fournisseur n’est plus disponible.");
      catalogueChange={id:line.catalogue_id,tier:index<0?null:index,before:index<0?Number(catalogue.prix_unitaire):tiers[index].unit_price,after:input.prix_unitaire_ht};
    }
    await tx.query(`UPDATE public.commande_fournisseur_ligne SET prix_unitaire_ht=$2,frais_ht=COALESCE($3,frais_ht),
      catalogue_pricing_snapshot=NULL,updated_at=now(),updated_by=$4 WHERE id=$1::uuid`,[line.id,input.prix_unitaire_ht,input.frais_ht??null,audit.user_id]);
    changes.push({ligne_id:line.id,before:{prix_unitaire_ht:line.prix_unitaire_ht,frais_ht:line.frais_ht},
      after:{prix_unitaire_ht:input.prix_unitaire_ht,frais_ht:input.frais_ht??line.frais_ht},catalogue:catalogueChange});
  }
  return changes;
}
