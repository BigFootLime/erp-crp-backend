import {priceCatalogueLine,type CataloguePriceSnapshot} from '../commande-fournisseur/domain/catalogue-line-pricing';
import {HttpError} from '../../utils/httpError';
import type {PoolClient} from 'pg';
import {readSubcontractForecastPredecessorsTx} from '../commande-fournisseur/repository/subcontract-purchase.repository';
import {recomputeTotauxTx} from '../commande-fournisseur/repository/commande-fournisseur.repository';
import {provisionalServiceQuantity} from '../planning/domain/procurement-forecast';
import {preparationAudit} from '../production/repository/production-preparation.repository';
import type {AuditContext} from '../production/repository/production.repository';

/** Only the one global provisional line follows output. Approved purchases and origin proofs stay immutable. */
export async function syncProvisionalSubcontractDraftsTx(tx:Pick<PoolClient,'query'>,ofId:number,audit:AuditContext){
 const lines=(await tx.query<{id:string;order_id:string;operation_id:string;quantity:number;planned:number;purchase_id:string;catalogue_pricing_snapshot:CataloguePriceSnapshot|null}>(`SELECT l.id::text,l.commande_id::text AS order_id,p.operation_id::text,GREATEST(0,l.quantite-COALESCE(l.qty_annulee,0))::float8 AS quantity,o.quantite_lancee::float8 AS planned,p.preparation_snapshot->'purchase'->>'id' AS purchase_id,l.catalogue_pricing_snapshot
  FROM public.subcontract_purchase_origins p JOIN public.commande_fournisseur_ligne l ON l.id=p.line_id JOIN public.commande_fournisseur c ON c.id=l.commande_id JOIN public.ordres_fabrication o ON o.id=p.of_id
  WHERE p.of_id=$1 AND p.preparation_snapshot->>'planningForecast'='true' AND c.statut='BROUILLON' AND l.statut_ligne='ACTIVE' ORDER BY l.commande_id,l.id FOR UPDATE OF c,l`,[ofId])).rows;
 const changed:Array<{line:string;before:number;after:number;final:boolean}>=[];
 for(const line of lines){
  if(lines.filter(l=>l.operation_id===line.operation_id&&l.purchase_id===line.purchase_id).length!==1)continue;
  const predecessors=await readSubcontractForecastPredecessorsTx(tx,line.operation_id);
  const target=provisionalServiceQuantity(line.planned,predecessors);
  // The purchase line schema requires a positive quantity. Zero conforming pieces cancels the provisional line.
  if(target.quantity===line.quantity)continue;
  if(target.quantity===0)await tx.query("UPDATE public.commande_fournisseur_ligne SET statut_ligne='ANNULEE',updated_at=now(),updated_by=$2 WHERE id=$1::uuid",[line.id,audit.user_id]);
  else {
   let price:{prix_unitaire_ht:number|null;frais_ht:number;remise_pct:number}|null=null;
   if(line.catalogue_pricing_snapshot){
    try{price=priceCatalogueLine({...line.catalogue_pricing_snapshot,moq:null},target.quantity);}
    catch(error){if(!(error instanceof HttpError)||error.status>=500)throw error;price={prix_unitaire_ht:null,frais_ht:0,remise_pct:0};}
   }
   await tx.query(`UPDATE public.commande_fournisseur_ligne SET quantite=$2+COALESCE(qty_annulee,0),updated_at=now(),updated_by=$3,
    prix_unitaire_ht=CASE WHEN $4::boolean THEN $5::numeric ELSE prix_unitaire_ht END,frais_ht=CASE WHEN $4::boolean THEN $6::numeric ELSE frais_ht END,remise_pct=CASE WHEN $4::boolean THEN 0 ELSE remise_pct END WHERE id=$1::uuid`,[line.id,target.quantity,audit.user_id,price!==null,price?.prix_unitaire_ht??null,price?.frais_ht??null]);
  }
  changed.push({line:line.id,before:line.quantity,after:target.quantity,final:target.final});
 }
 for(const orderId of new Set(lines.filter(l=>changed.some(c=>c.line===l.id)).map(l=>l.order_id))){await recomputeTotauxTx(tx,orderId);await tx.query('UPDATE public.commande_fournisseur SET updated_by=$2 WHERE id=$1::uuid',[orderId,audit.user_id]);}
 if(changed.length)await preparationAudit(tx,audit,ofId,'production.subcontract.provisional-quantity.updated',{changes:changed});
}
