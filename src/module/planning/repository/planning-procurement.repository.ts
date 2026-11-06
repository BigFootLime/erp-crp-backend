import {savePurchasePreparationsTx} from '../../production/repository/purchase-preparation.repository';
import pool from '../../../config/database';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { HttpError } from '../../../utils/httpError';
import { coverageFingerprint,purchaseQuantity } from '../../production/domain/of-material';
import { consumableCommand } from '../../production/repository/consumable-command.repository';
import { readMaterialTx } from '../../production/repository/of-material.repository';
import { readSubcontractProcurementTx } from '../../subcontract/subcontract-procurement.repository';
import { isSubcontractPieceUnit } from '../../subcontract/subcontract-procurement.domain';
import { createMaterialDraftsTx,type MaterialDraftLine } from '../../commande-fournisseur/repository/commande-fournisseur.repository';
import type { AuditContext } from '../../production/repository/production.repository';
import { readPlanningSupplyStates,supplyEntrySchema,type PlanningSupplyState } from './planning-supply-state';

export const savePlanningProcurementSchema=z.object({expectedVersion:z.string().min(1),idempotencyKey:z.string().uuid(),entries:z.array(supplyEntrySchema).max(300)}).strict();
type Entry={key:string;kind:'MATIERE'|'PRESTATION';sourceRef:string;operationId:string|null;label:string;unit:string|null;missing:number;required:number;supplierId:string|null;catalogueId:string|null;due:string|null;actions:string[];articleId:string|null;needId:string|null;destinationId:string|null;currency:string;price:number|null;orders:Array<{id:string;code:string}>;offers:Array<{id:string;supplierId:string;label:string;unit:string}>};
async function readTx(tx:Pick<PoolClient,'query'>,ofId:number){
 const material=await readMaterialTx(tx,ofId),service=await readSubcontractProcurementTx(tx,ofId);
 const state=(await readPlanningSupplyStates(tx,[ofId])).get(ofId);
 const {rows:lines}=await tx.query<{id:string;order_id:string;code:string;status:string;updated_at:string;source_ref:string|null;operation_id:string|null;quantity:number;article_id:string|null;due:string|null}>(`SELECT l.id::text,c.id::text AS order_id,c.code,c.statut::text AS status,l.updated_at::text,
  COALESCE(origin.preparation_snapshot->'purchase'->>'id',b.besoin_ref) AS source_ref,origin.operation_id::text,l.quantite::float8 AS quantity,l.article_id::text,l.date_besoin::text AS due
  FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id
  LEFT JOIN public.subcontract_purchase_origins origin ON origin.line_id=l.id
  LEFT JOIN public.commande_fournisseur_ligne_besoin b ON b.ligne_id=l.id AND NOT b.annule
  WHERE (l.of_id=$1 OR b.besoin_of_id=$1 OR origin.of_id=$1) AND l.statut_ligne='ACTIVE' AND c.statut<>'ANNULEE' ORDER BY l.id`,[ofId]);
 const offers=(await tx.query<{id:string;article_id:string;supplier_id:string;label:string;unit:string;currency:string;price:number|null;moq:number|null;pack:number|null}>(`SELECT c.id::text,c.article_id::text,c.fournisseur_id::text AS supplier_id,COALESCE(f.nom,f.raison_sociale)||' · '||c.unite AS label,c.unite AS unit,c.devise AS currency,c.prix_unitaire::float8 AS price,c.moq::float8 AS moq,c.lot_achat::float8 AS pack
  FROM public.fournisseur_catalogue c JOIN public.fournisseurs f ON f.id=c.fournisseur_id WHERE c.actif AND f.actif IS NOT FALSE
  AND (c.valid_from IS NULL OR c.valid_from<=current_date) AND(c.valid_to IS NULL OR c.valid_to>=current_date)
  AND c.article_id=ANY($1::uuid[]) ORDER BY label,c.id`,[[...new Set([...material.needs.flatMap(n=>n.articleId?[n.articleId]:[]),...service.purchases.flatMap(p=>p.article_id?[p.article_id]:[])])]])).rows;
 const articles=(await tx.query<{id:string;unit:string}>(`SELECT id::text,unite AS unit FROM public.articles WHERE id=ANY($1::uuid[])`,[service.purchases.flatMap(p=>p.article_id?[p.article_id]:[])])).rows;
 const entries:Entry[]=[];
 const linked=(sourceRef:string,operationId?:string|null)=>[...new Map(lines.filter(l=>l.source_ref===sourceRef&&(!operationId||l.operation_id===operationId)).map(l=>[l.order_id,{id:l.order_id,code:l.code}])).values()];
 for(const need of material.needs){
  const key='MATIERE:'+need.key,saved=state?.entries.find(e=>e.key===key);
  entries.push({key,kind:'MATIERE',sourceRef:need.key,operationId:need.operationId,label:need.designation,unit:need.unit,required:need.required,
   missing:Math.max(0,need.purchaseMissing),supplierId:saved?.supplierId??need.supplierId,catalogueId:saved?.catalogueId??null,due:saved?.due??null,
   actions:need.blockers,articleId:need.articleId,needId:need.id,destinationId:need.destinationId,currency:need.currency,price:need.price,orders:linked(need.key),
   offers:offers.filter(o=>o.article_id===need.articleId&&o.unit===need.unit).map(o=>({id:o.id,supplierId:o.supplier_id,label:o.label,unit:o.unit}))});
 }
 for(const prep of service.purchasePreparations){
  const purchase=service.purchases.find(p=>p.id===prep.sourceRef),key='PRESTATION:'+prep.sourceRef,saved=state?.entries.find(e=>e.key===key);
  const operation=service.operations.find(o=>o.id===prep.service.selection.operationId)||service.operations.find(o=>o.sourceId===purchase?.gamme_operation_id)||(service.operations.length===1?service.operations[0]:undefined);
  const eligible=offers.filter(o=>o.article_id===purchase?.article_id&&isSubcontractPieceUnit(o.unit));
  const selected=eligible.find(o=>o.id===(saved?.catalogueId??prep.service.selection.catalogueId));
  entries.push({key,kind:'PRESTATION',sourceRef:prep.sourceRef!,operationId:operation?.id??null,label:prep.designation,unit:selected?.unit??articles.find(a=>a.id===purchase?.article_id)?.unit??null,
   required:service.of.quantity,missing:Math.max(0,service.of.quantity-service.drafts.filter(d=>d.purchaseId===purchase?.id&&d.operationId===operation?.id).reduce((n,d)=>n+d.quantity,0)),
   supplierId:saved?.supplierId??selected?.supplier_id??prep.supplierId,catalogueId:selected?.id??null,due:saved?.due??prep.service.selection.due,
   actions:prep.actions,articleId:purchase?.article_id??null,needId:null,destinationId:prep.destinationId,currency:selected?.currency??'EUR',price:selected?.price??null,orders:linked(prep.sourceRef!,operation?.id),
   offers:eligible.map(o=>({id:o.id,supplierId:o.supplier_id,label:o.label,unit:o.unit}))});
 }
 return {of:{id:ofId,number:material.number},version:coverageFingerprint({material:material.version,service:service.version,state,lines}),entries,suppliers:material.suppliers as Array<{id:string;name:string}>,material,service,lines,offers};
}
function dto(current:Awaited<ReturnType<typeof readTx>>){return {of:current.of,version:current.version,suppliers:current.suppliers,entries:current.entries.map(({price:_price,currency:_currency,needId:_needId,destinationId:_destinationId,articleId:_articleId,...entry})=>entry)};}
export async function readPlanningProcurement(ofId:number){const tx=await pool.connect();try{await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const value=dto(await readTx(tx,ofId));await tx.query('COMMIT');return value;}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}}
export async function savePlanningProcurement(ofId:number,body:z.infer<typeof savePlanningProcurementSchema>,audit:AuditContext,canPurchase:boolean){
 return consumableCommand({ofId},'PLANNING_SUPPLY_PREPARATION',body,audit,async tx=>{
  const current=await readTx(tx,ofId);
  if(current.version!==body.expectedVersion)throw new HttpError(409,'PLANNING_SUPPLY_CHANGED','Les besoins, le stock ou les achats ont changé. Actualisez la préparation.');
  if(current.service.coveredByOfId)throw new HttpError(409,'OF_COVERED_BY_CONSOLIDATION','Préparez les achats dans l’OF de regroupement.');
  if(new Set(body.entries.map(e=>e.key)).size!==body.entries.length||body.entries.length!==current.entries.length||body.entries.some(e=>!current.entries.some(row=>row.key===e.key)))throw new HttpError(422,'PLANNING_SUPPLY_INVALID','Relisez les besoins de cet OF.');
  const saved:PlanningSupplyState['entries']=[];
  for(const input of body.entries){
   const entry=current.entries.find(e=>e.key===input.key)!;
   if(input.supplierId&&!current.suppliers.some(s=>s.id===input.supplierId))throw new HttpError(422,'PLANNING_SUPPLIER_INVALID','Choisissez un fournisseur actif.');
   const offer=input.catalogueId?current.offers.find(o=>o.id===input.catalogueId&&o.article_id===entry.articleId&&o.supplier_id===input.supplierId):null;
   if(input.catalogueId&&(!offer||entry.kind==='MATIERE'&&offer.unit!==entry.unit))throw new HttpError(422,'PLANNING_OFFER_INVALID','Les conditions fournisseur ne sont plus applicables.');
   const actions=[...entry.actions],orders=[...entry.orders],unit=offer?.unit??entry.unit;
   if(entry.missing>0){
    if(!input.due)actions.push(entry.kind==='PRESTATION'?'Renseigner le retour prévu pour dater la suite.':'Renseigner la disponibilité prévue de la matière.');
    if(!input.supplierId)actions.push('Besoin d’achat conservé : choisir le fournisseur pour générer la commande brouillon.');
    else if(!canPurchase)actions.push('Faire préparer le brouillon par une personne habilitée aux achats.');
    else if(!current.material.technicalHash||!entry.articleId||!unit||entry.kind==='PRESTATION'&&(!entry.operationId||!isSubcontractPieceUnit(unit)))actions.push('Compléter l’article, l’unité ou la phase avant de générer le brouillon.');
    else if(entry.kind==='MATIERE'&&current.material.needs.find(n=>n.key===entry.sourceRef)?.supplyMode==='CUSTOMER')actions.push('Matière client : préparer un appel client, sans achat fournisseur.');
    else if(entry.kind==='MATIERE'&&current.material.needs.find(n=>n.key===entry.sourceRef)?.purchaseRequiresBarReview)actions.push('Vérifier les barres du stock existant avant de préparer un achat.');
    else if(entry.kind==='MATIERE'&&current.material.needs.find(n=>n.key===entry.sourceRef)?.futureSupplies.some(s=>!s.reasons.length&&s.available>0))actions.push('Un achat attendu existe : le rapprocher du besoin avant de créer un autre brouillon.');
    else {
     const need=current.material.needs.find(n=>n.key===entry.sourceRef),quantity=entry.kind==='MATIERE'?purchaseQuantity(entry.missing,offer?.moq??(input.supplierId===need!.supplierId?need!.catalog?.moq:null)??null,offer?.pack??(input.supplierId===need!.supplierId?need!.catalog?.lot_achat:null)??null).ordered:entry.missing;
     const created=await createMaterialDraftsTx(tx,[{ofId,sourceRef:entry.sourceRef,needId:entry.needId,articleId:entry.articleId!,designation:entry.label,
      supplierId:input.supplierId,currency:offer?.currency??entry.currency,destinationId:entry.destinationId,unit:unit!,quantity,assigned:entry.kind==='MATIERE'?entry.missing:0,price:offer?.price??(input.supplierId===entry.supplierId?entry.price:null),due:input.due,
      catalogueId:offer?.id,type:entry.kind==='PRESTATION'?'SOUS_TRAITANCE':'MATIERE',operation:entry.operationId?current.material.operations.find(o=>o.id===entry.operationId)?.label??entry.label:entry.label,requirements:need?[need.requirements.grade,need.requirements.condition,...need.requirements.certificates,...need.requirements.manualChecks,...Object.entries(need.requirements.dimensions).map(([key,value])=>`${key}: ${value} mm minimum`)].filter((v):v is string=>!!v):[],
      ...(entry.kind==='MATIERE'?{allocations:[{needId:entry.needId,sourceRef:entry.sourceRef,ofId,assigned:entry.missing}]}:{subcontract:{operationId:entry.operationId!,materialOriginId:current.service.origins.length===1?current.service.origins[0].id:null,
       snapshot:{purchase:current.service.purchases.find(p=>p.id===entry.sourceRef),planningForecast:current.service.hasDirectMaterial&&current.service.origins.length!==1,unit:unit!,quantity:entry.missing,technicalHash:current.material.technicalHash}}})} satisfies MaterialDraftLine],audit);
     orders.push(...created);actions.push('Commande fournisseur en brouillon : prix, exigences et origines à confirmer avant validation.');
    }
   }
   if(entry.kind==='PRESTATION'&&entry.operationId&&canPurchase){
    const selected=await readSubcontractProcurementTx(tx,ofId,{purchaseId:entry.sourceRef,operationId:entry.operationId,catalogueId:input.catalogueId,destinationId:entry.destinationId,due:input.due});
    await savePurchasePreparationsTx(tx,selected.purchasePreparations,'PRESTATION',ofId,selected.version,audit,{persistCovered:true});
   }
   saved.push({...input,kind:entry.kind,sourceRef:entry.sourceRef,operationId:entry.operationId,label:entry.label,missing:entry.kind==='PRESTATION'?entry.required:Math.max(0,entry.required-(current.material.needs.find(n=>n.key===entry.sourceRef)?.consumed??0)-(current.material.needs.find(n=>n.key===entry.sourceRef)?.reserved??0)),orders:[...new Map(orders.map(o=>[o.id,o])).values()],actions:[...new Set(actions)]});
  }
  const state:PlanningSupplyState={technicalHash:current.material.technicalHash,technicalVersion:current.material.technicalVersion,revisionId:current.service.of.ofRevisionId,entries:saved};
  await tx.query(`UPDATE public.ordres_fabrication SET technical_preparation=COALESCE(technical_preparation,'{}'::jsonb)||jsonb_build_object('planning_supply',$2::jsonb),updated_at=clock_timestamp(),updated_by=$3 WHERE id=$1`,[ofId,JSON.stringify(state),audit.user_id]);
  await tx.query('UPDATE public.planning_central_settings SET revision=revision+1,updated_at=clock_timestamp() WHERE singleton');
  return {...dto(await readTx(tx,ofId)),messages:saved.flatMap(e=>e.actions),orders:saved.flatMap(e=>e.orders)};
 });
}
