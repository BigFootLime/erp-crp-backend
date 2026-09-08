import type {PoolClient} from 'pg';
import type {DossierDb} from './of-dossier.repository';
import {futureSupplyBalance} from '../domain/material-future-supply';
import type {MaterialRequirements} from '../domain/of-material';
import {HttpError} from '../../../utils/httpError';

export type FutureMaterialSupply={id:string;commandId:string;code:string;status:string;articleId:string;designation:string;unit:string|null;purchaseUnit:string|null;
  coefficient:number;ordered:number;cancelled:number;assigned:number;received:number;destinationId:string|null;ownerClientId:string|null;due:string|null;
  requirements:Array<{type:string;valeur:string;obligatoire:boolean}>;documents:string[];version:string;allocatedNeedIds:string[];allocationEnd:number};

export async function readFutureMaterialSupplyTx(tx:DossierDb,articleIds:string[]){
  const rows=(await tx.query<FutureMaterialSupply>(`SELECT l.id::text,c.id::text AS "commandId",c.code,c.statut AS status,l.article_id::text AS "articleId",l.designation,
    COALESCE(l.unite_stock,l.unite) AS unit,l.unite AS "purchaseUnit",COALESCE(l.coef_conversion,1)::float8 AS coefficient,l.quantite::float8 AS ordered,l.qty_annulee::float8 AS cancelled,
    COALESCE(b.assigned,0)::float8 AS assigned,COALESCE(b.allocation_end,0)::float8 AS "allocationEnd",COALESCE(r.received,0)::float8 AS received,COALESCE(l.magasin_id,c.magasin_livraison_id)::text AS "destinationId",
    m.client_proprietaire_id AS "ownerClientId",COALESCE(l.date_promesse,c.date_promesse)::text AS due,l.exigences_qualite AS requirements,l.documents_attendus AS documents,
    concat_ws(':',c.updated_at,l.updated_at) AS version,COALESCE(b.need_ids,'{}'::text[]) AS "allocatedNeedIds"
    FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id LEFT JOIN public.articles_matiere m ON m.article_id=l.article_id
    LEFT JOIN LATERAL(SELECT sum(qty) AS assigned,max(COALESCE(stock_receipt_offset,earlier,0)+qty) AS allocation_end,
      array_agg(material_need_id::text) FILTER(WHERE material_need_id IS NOT NULL) AS need_ids FROM(
        SELECT material_need_id,stock_receipt_offset,
          CASE WHEN besoin_type='OF_MATERIAL' THEN quantite_couverte ELSE quantite_couverte*COALESCE(l.coef_conversion,1) END AS qty,
          sum(CASE WHEN besoin_type='OF_MATERIAL' THEN quantite_couverte ELSE quantite_couverte*COALESCE(l.coef_conversion,1) END)
            OVER(ORDER BY created_at,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS earlier
        FROM public.commande_fournisseur_ligne_besoin WHERE ligne_id=l.id AND NOT annule) assigned_rows) b ON true
    LEFT JOIN LATERAL(SELECT sum(rl.qty_received*COALESCE(rl.stock_conversion_coef,l.coef_conversion,1)) AS received FROM public.reception_fournisseur_lignes rl WHERE rl.commande_fournisseur_ligne_id=l.id) r ON true
    WHERE l.article_id=ANY($1::uuid[]) AND l.statut_ligne='ACTIVE' AND c.statut NOT IN ('ANNULEE','CLOTUREE')
    ORDER BY COALESCE(l.date_promesse,c.date_promesse) NULLS LAST,c.created_at,l.position,l.id`,[articleIds])).rows;
  return rows.map(row=>({...row,...futureSupplyBalance(row)})).filter(row=>row.available>0);
}

export function futureSupplyCompatibility(need:{id:string|null;articleId:string|null;unit:string|null;destinationId:string|null;supplyMode:string;requirements:MaterialRequirements},source:Awaited<ReturnType<typeof readFutureMaterialSupplyTx>>[number]){
  const reasons:string[]=[];
  if(need.supplyMode!=='PURCHASE'||need.requirements.ownerClientId!==source.ownerClientId)reasons.push('Propriété client incompatible avec cet achat.');
  if(need.articleId!==source.articleId)reasons.push('Article incompatible.');
  if(!need.unit||need.unit.trim().toUpperCase()!==source.unit?.trim().toUpperCase()||source.purchaseUnit!==source.unit&&source.coefficient===1)
    reasons.push('La conversion vers l’unité du besoin doit être confirmée sur l’achat.');
  if(need.destinationId!==source.destinationId)reasons.push('Le magasin de livraison diffère de celui du besoin.');
  if(need.id&&source.allocatedNeedIds.includes(need.id))reasons.push('La part déjà attribuée figure dans les approvisionnements affectés.');
  // Receipt offsets keep prior, possibly quarantined stock out of a new promise.
  return reasons;
}

export async function lockFutureMaterialSupplyTx(tx:PoolClient,lineIds:string[]){
  if(!lineIds.length)return;
  await tx.query(`SELECT c.id FROM public.commande_fournisseur c WHERE c.id IN(SELECT commande_id FROM public.commande_fournisseur_ligne WHERE id=ANY($1::uuid[])) ORDER BY c.id FOR UPDATE`,[lineIds]);
  await tx.query('SELECT id FROM public.commande_fournisseur_ligne WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[lineIds]);
}

export async function allocateFutureMaterialSupplyTx(tx:PoolClient,input:{lineId:string;needId:string;sourceRef:string;ofId:number;quantity:number}){
  if(input.quantity<=0)throw new HttpError(422,'MATERIAL_FUTURE_QUANTITY_INVALID','La quantité attendue doit être positive.');
  const line=(await tx.query('SELECT article_id::text FROM public.commande_fournisseur_ligne WHERE id=$1::uuid',[input.lineId])).rows[0];
  const current=line?(await readFutureMaterialSupplyTx(tx,[line.article_id])).find(s=>s.id===input.lineId):null;
  if(!current||input.quantity>current.available)throw new HttpError(409,'MATERIAL_FUTURE_SUPPLY_CHANGED','Le solde attendu a changé. Actualisez la couverture.');
  await tx.query(`INSERT INTO public.commande_fournisseur_ligne_besoin(ligne_id,besoin_type,besoin_ref,besoin_of_id,of_id,quantite_couverte,material_need_id,stock_receipt_offset)
    VALUES($1::uuid,'OF_MATERIAL',$2,$3,$3,$4,$5::uuid,$6)`,[input.lineId,input.sourceRef,input.ofId,input.quantity,input.needId,Math.max(current.received,current.allocationEnd)]);
}
