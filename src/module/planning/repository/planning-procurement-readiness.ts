import type {PoolClient} from 'pg';
import {readSubcontractForecastPredecessorsTx} from '../../commande-fournisseur/repository/subcontract-purchase.repository';
import {provisionalServiceQuantity} from '../domain/procurement-forecast';

/** Current ledgers own readiness; historical preview messages are never reused. */
export async function readProcurementWarningsTx(tx:Pick<PoolClient,'query'>,ofId:number,versionId:string|null,planned:number,purchases:Array<{id:string;type_achat:string;article_id?:string|null;designation?:string|null;nom?:string|null;gamme_operation_id?:string|null}>){
 const orders=(await tx.query<{source:string;code:string;status:string;quantity:number;forecast:boolean;promise:string|null;operation:string|null}>(`SELECT DISTINCT COALESCE(origin.preparation_snapshot->'purchase'->>'id',b.besoin_ref) AS source,c.code,c.statut::text AS status,GREATEST(0,l.quantite-COALESCE(l.qty_annulee,0))::float8 AS quantity,COALESCE(origin.preparation_snapshot->>'planningForecast'='true',false) AS forecast,COALESCE(l.date_promesse,c.date_promesse)::text AS promise,origin.operation_id::text AS operation
  FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id
  LEFT JOIN public.commande_fournisseur_ligne_besoin b ON b.ligne_id=l.id AND NOT b.annule
  LEFT JOIN public.subcontract_purchase_origins origin ON origin.line_id=l.id
  WHERE (l.of_id=$1 OR b.besoin_of_id=$1) AND l.statut_ligne='ACTIVE' AND c.statut<>'ANNULEE'`,[ofId])).rows;
 const needs=(await tx.query<{source:string;reviewed:boolean;mode:string;required:number;physical:number}>(`SELECT n.source_ref AS source,n.specification_reviewed_at IS NOT NULL AS reviewed,n.supply_mode AS mode,n.required_qty::float8 AS required,
  COALESCE((SELECT sum(r.qty_consumed+CASE WHEN r.status='ACTIVE' THEN GREATEST(0,r.qty_reserved-r.qty_consumed) ELSE 0 END) FROM public.stock_reservations r WHERE r.material_need_id=n.id),0)::float8 AS physical
  FROM public.of_material_needs n WHERE n.of_id=$1 AND n.technical_version_id=$2::uuid AND n.superseded_at IS NULL`,[ofId,versionId])).rows;
 const bySource=new Map<string,string[]>();
 for(const purchase of purchases.filter(p=>['MATIERE','TRAITEMENT','SOUS_TRAITANCE'].includes(p.type_achat))){
  const messages:string[]=[];bySource.set(purchase.id,messages);
  const label=purchase.designation??purchase.nom??'Achat à préparer',lines=orders.filter(o=>o.source===purchase.id);
  if(!purchase.article_id)messages.push(`${label} : article fournisseur à renseigner.`);
  if(purchase.type_achat==='MATIERE'){
   const need=needs.find(n=>n.source===purchase.id);
   if(!need?.reviewed)messages.push(`${label} : confirmer les exigences et l’opération consommatrice.`);
   if(need?.mode==='CUSTOMER'||need&&need.physical>=need.required)continue;
   if(!lines.length)messages.push(`${label} : choisir le fournisseur et préparer le brouillon pour le manque.`);
  }else{
   const operation=lines.find(l=>l.operation)?.operation??(await tx.query<{id:string}>(`SELECT id::text FROM public.of_operations WHERE of_id=$1 AND source_piece_operation_id=$2::uuid AND status::text<>'CANCELLED' ORDER BY phase,id LIMIT 1`,[ofId,purchase.gamme_operation_id??null])).rows[0]?.id;
   const target=provisionalServiceQuantity(planned,operation?await readSubcontractForecastPredecessorsTx(tx,operation):[]);
   if(lines.reduce((sum,line)=>sum+line.quantity,0)<target.quantity)messages.push(`${label} : préparer le complément fournisseur.`);
   if(lines.some(l=>l.forecast&&l.status==='BROUILLON'))messages.push(`${label} : confirmer la quantité et les origines après le contrôle de sortie d’usinage.`);
  }
  for(const line of lines){
   if(line.status==='BROUILLON')messages.push(`${label} : ${line.code} en brouillon, à compléter par l’acheteur.`);
   else if(line.status==='A_VALIDER')messages.push(`${label} : ${line.code} attend sa validation.`);
   else if(['APPROUVEE','ENVOYEE'].includes(line.status)&&!line.promise)messages.push(`${label} : AR fournisseur et date de retour à confirmer.`);
  }
 }
 return bySource;
}
