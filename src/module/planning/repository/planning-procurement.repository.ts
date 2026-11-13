import { randomUUID } from 'node:crypto';
import { materialWorkflowEnabled } from '../../production/repository/of-dossier.repository';
import { reserveMaterialSelectionTx } from '../../production/repository/of-material-confirmation.repository';
import { consumeMaterialReservationTx } from '../../stock/repository/partial-reservation-consumption.repository';
import {defaultProcurementDay,parisDay,provisionalServiceQuantity} from '../domain/procurement-forecast';
import {readSubcontractForecastPredecessorsTx} from '../../commande-fournisseur/repository/subcontract-purchase.repository';
import {readProcurementWarningsTx} from './planning-procurement-readiness';
import {preparationAudit} from '../../production/repository/production-preparation.repository';
import {savePurchasePreparationsTx} from '../../production/repository/purchase-preparation.repository';
import pool from '../../../config/database';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { HttpError } from '../../../utils/httpError';
import { coverageFingerprint,purchaseQuantity,quantity as materialQuantity } from '../../production/domain/of-material';
import { consumableCommand } from '../../production/repository/consumable-command.repository';
import { readMaterialTx,saveMaterialConfigurationTx,linkUnassignedMaterialPurchasesTx } from '../../production/repository/of-material.repository';
import { readSubcontractProcurementTx } from '../../subcontract/subcontract-procurement.repository';
import { isSubcontractPieceUnit } from '../../subcontract/subcontract-procurement.domain';
import { createMaterialDraftsTx,type MaterialDraftLine } from '../../commande-fournisseur/repository/commande-fournisseur.repository';
import type { AuditContext } from '../../production/repository/production.repository';
import { readPlanningSupplyStates,supplyEntrySchema,type PlanningSupplyState } from './planning-supply-state';

export const savePlanningProcurementSchema=z.object({expectedVersion:z.string().min(1),idempotencyKey:z.string().uuid(),entries:z.array(supplyEntrySchema).max(300),scope:z.enum(['material','treatment']).optional(),operationId:z.string().uuid().optional(),deferMaterialPurchase:z.boolean().optional()}).strict()
 .refine(body=>body.scope!=='treatment'||!!body.operationId,'Sélectionnez l’opération de traitement.')
 .refine(body=>!body.deferMaterialPurchase||body.scope==='material','Le contrôle de stock est réservé à la matière.');
type MaterialRead=Awaited<ReturnType<typeof readMaterialTx>>;
const canReviewMaterial=(need:MaterialRead['needs'][number])=>
  !need.id&&!!need.articleId&&!!need.operationId&&!!need.debitRule&&need.debitRule.form!=='SHEET';
const isPurchasePieceUnit=(unit:string)=>isSubcontractPieceUnit(unit)||/^barres?$/i.test(unit.trim());
const matchesMaterialUnit=(offer:{unit:string;stock_unit:string|null;coefficient:number|null},unit:string|null)=>
  unit!==null&&(offer.unit===unit
    ?(!offer.stock_unit||offer.stock_unit===unit)&&(offer.coefficient===null||offer.coefficient===1)
    :offer.stock_unit===unit&&offer.coefficient!==null&&offer.coefficient>0);
type MaterialPrice={articleId:string;supplierId:string;unit:string;price:number;currency:string};
type Entry={key:string;kind:'MATIERE'|'PRESTATION';sourceRef:string;operationId:string|null;label:string;unit:string|null;missing:number;required:number;stock?:{reserved:number;consumed:number;expected:number;receivedBlocked:number;proposed:number};materialReview?:{form:string;operation:string|null;grade:string|null;condition:string|null;dimensions:Record<string,number>;unitsPerBlank:number;kerfPerBlank:number;piecesPerBlank:number;newDefinition:boolean;needsDefinition:boolean;barReview:boolean;customer:boolean;futurePurchase:boolean};supplierId:string|null;catalogueId:string|null;due:string|null;actions:string[];articleId:string|null;needId:string|null;destinationId:string|null;currency:string;price:number|null;orders:Array<{id:string;code:string;status?:string;quantity?:number;due?:string|null;supplierName?:string|null}>;offers:Array<{id:string;supplierId:string;label:string;unit:string}>};
export async function readPlanningProcurementTx(tx:Pick<PoolClient,'query'>,ofId:number){
 const material=await readMaterialTx(tx,ofId,true),service=await readSubcontractProcurementTx(tx,ofId);
 const state=(await readPlanningSupplyStates(tx,[ofId])).get(ofId);
 const {rows:lines}=await tx.query<{id:string;order_id:string;code:string;status:string;created_at:string;updated_at:string;source_ref:string|null;operation_id:string|null;quantity:number;article_id:string|null;due:string|null;supplier_name:string|null}>(`SELECT l.id::text,c.id::text AS order_id,c.code,c.statut::text AS status,c.created_at::text,l.updated_at::text,
  COALESCE(origin.preparation_snapshot->'purchase'->>'id',b.besoin_ref) AS source_ref,origin.operation_id::text,GREATEST(0,l.quantite-COALESCE(l.qty_annulee,0))::float8 AS quantity,l.article_id::text,COALESCE(l.date_promesse,c.date_promesse)::text AS due,COALESCE(f.nom,f.raison_sociale) AS supplier_name
  FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id
  LEFT JOIN public.fournisseurs f ON f.id=c.fournisseur_id
  LEFT JOIN public.subcontract_purchase_origins origin ON origin.line_id=l.id
  LEFT JOIN public.commande_fournisseur_ligne_besoin b ON b.ligne_id=l.id AND NOT b.annule
  WHERE (l.of_id=$1 OR b.besoin_of_id=$1 OR origin.of_id=$1) AND l.statut_ligne='ACTIVE' AND c.statut<>'ANNULEE' ORDER BY l.id`,[ofId]);
 const offers=(await tx.query<{id:string;article_id:string;supplier_id:string;label:string;unit:string;stock_unit:string|null;coefficient:number|null;currency:string;price:number|null;moq:number|null;pack:number|null}>(`SELECT c.id::text,c.article_id::text,c.fournisseur_id::text AS supplier_id,COALESCE(f.nom,f.raison_sociale)||' · '||c.unite AS label,c.unite AS unit,c.unite_stock AS stock_unit,c.coef_conversion::float8 AS coefficient,c.devise AS currency,c.prix_unitaire::float8 AS price,c.moq::float8 AS moq,c.lot_achat::float8 AS pack
  FROM public.fournisseur_catalogue c JOIN public.fournisseurs f ON f.id=c.fournisseur_id WHERE c.actif AND f.actif IS NOT FALSE
  AND (c.valid_from IS NULL OR c.valid_from<=current_date) AND(c.valid_to IS NULL OR c.valid_to>=current_date)
  AND c.article_id=ANY($1::uuid[]) ORDER BY c.updated_at DESC,c.id`,[[...new Set([...material.needs.flatMap(n=>n.articleId?[n.articleId]:[]),...service.purchases.flatMap(p=>p.article_id?[p.article_id]:[])])]])).rows;
 const articles=(await tx.query<{id:string;unit:string}>(`SELECT id::text,unite AS unit FROM public.articles WHERE id=ANY($1::uuid[])`,[service.purchases.flatMap(p=>p.article_id?[p.article_id]:[])])).rows;
 const materialPrices=(await tx.query<MaterialPrice>(`SELECT DISTINCT ON (l.article_id,c.fournisseur_id,l.unite)
  l.article_id::text AS "articleId",c.fournisseur_id::text AS "supplierId",l.unite AS unit,l.prix_unitaire_ht::float8 AS price,c.devise AS currency
  FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id
  WHERE l.article_id=ANY($1::uuid[]) AND l.statut_ligne='ACTIVE' AND l.prix_unitaire_ht IS NOT NULL
    AND c.statut IN ('APPROUVEE','ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE','RECUE','CLOTUREE')
  ORDER BY l.article_id,c.fournisseur_id,l.unite,c.created_at DESC,l.id DESC`,[material.needs.flatMap(n=>n.articleId?[n.articleId]:[])])).rows;
 const entries:Entry[]=[];
 const linked=(sourceRef:string,operationId?:string|null)=>[...new Map(lines.filter(l=>l.source_ref===sourceRef&&(!operationId||l.operation_id===operationId)).map(l=>[l.order_id,{id:l.order_id,code:l.code,status:l.status,due:l.due,supplierName:l.supplier_name,quantity:lines.filter(row=>row.order_id===l.order_id&&row.source_ref===sourceRef).reduce((sum,row)=>sum+row.quantity,0)}])).values()];
 for(const need of material.needs){
  const key='MATIERE:'+need.key,saved=state?.entries.find(e=>e.key===key);
  entries.push({key,kind:'MATIERE',sourceRef:need.key,operationId:need.operationId??need.configurationProposal?.operationId??null,label:need.designation,unit:need.unit,required:need.required,
   stock:{reserved:need.reserved,consumed:need.consumed,expected:need.expected,receivedBlocked:need.receivedBlocked,proposed:materialQuantity(need.missing-need.purchaseMissing)},
   ...(need.debitRule?{materialReview:{form:need.debitRule.form,operation:need.operationLabel,grade:need.requirements.grade,condition:need.requirements.condition,
    dimensions:need.requirements.dimensions,unitsPerBlank:need.debitRule.unitsPerBlank,kerfPerBlank:need.debitRule.kerfPerBlank,piecesPerBlank:need.debitRule.piecesPerBlank??1,
    newDefinition:canReviewMaterial(need),needsDefinition:!need.reviewed&&!canReviewMaterial(need),barReview:need.purchaseRequiresBarReview,
    customer:need.supplyMode==='CUSTOMER',futurePurchase:need.futureSupplies.some(s=>!s.reasons.length&&s.available>0)}}:{}),
   missing:Math.max(0,need.purchaseMissing),supplierId:need.supplierId,catalogueId:saved?saved.catalogueId:need.catalog?.id??offers.find(o=>o.article_id===need.articleId&&o.supplier_id===need.supplierId&&matchesMaterialUnit(o,need.unit))?.id??null,due:saved?.due??(need.purchaseMissing>0?defaultProcurementDay(lines.filter(l=>l.source_ref===need.key).map(l=>l.created_at).sort()[0]??new Date().toISOString()):null),
   actions:need.blockers,articleId:need.articleId,needId:need.id,destinationId:need.destinationId,currency:need.currency,price:need.price,orders:linked(need.key),
   offers:offers.filter(o=>o.article_id===need.articleId&&matchesMaterialUnit(o,need.unit)).map(o=>({id:o.id,supplierId:o.supplier_id,label:o.label,unit:o.unit}))});
 }
 for(const prep of service.purchasePreparations){
  const purchase=service.purchases.find(p=>p.id===prep.sourceRef),key='PRESTATION:'+prep.sourceRef,saved=state?.entries.find(e=>e.key===key);
  const operation=service.operations.find(o=>o.id===prep.service.selection.operationId)||service.operations.find(o=>o.sourceId===purchase?.gamme_operation_id)||(service.operations.length===1?service.operations[0]:undefined);
  const eligible=offers.filter(o=>o.article_id===purchase?.article_id&&isSubcontractPieceUnit(o.unit));
  const selected=eligible.find(o=>o.id===(saved?.catalogueId??prep.service.selection.catalogueId))??(eligible.filter(o=>o.supplier_id===purchase?.fournisseur_id).length===1?eligible.find(o=>o.supplier_id===purchase?.fournisseur_id):undefined);
  const target=provisionalServiceQuantity(service.of.quantity,operation?await readSubcontractForecastPredecessorsTx(tx,operation.id):[]).quantity;
  entries.push({key,kind:'PRESTATION',sourceRef:prep.sourceRef!,operationId:operation?.id??null,label:prep.designation,unit:selected?.unit??articles.find(a=>a.id===purchase?.article_id)?.unit??null,
   required:target,missing:Math.max(0,target-service.drafts.filter(d=>d.purchaseId===purchase?.id&&d.operationId===operation?.id).reduce((n,d)=>n+d.quantity,0)),
   supplierId:saved?saved.supplierId:selected?.supplier_id??purchase?.fournisseur_id??prep.supplierId,catalogueId:selected?.id??null,due:saved?saved.due:prep.service.selection.due,
   actions:prep.actions,articleId:purchase?.article_id??null,needId:null,destinationId:prep.destinationId,currency:selected?.currency??'EUR',price:selected?.price??null,orders:linked(prep.sourceRef!,operation?.id),
   offers:eligible.map(o=>({id:o.id,supplierId:o.supplier_id,label:o.label,unit:o.unit}))});
 }
 const warnings=await readProcurementWarningsTx(tx,ofId,material.technicalVersion,service.of.quantity,[...service.purchases,...material.needs.map(n=>({id:n.key,type_achat:'MATIERE',article_id:n.articleId,designation:n.designation}))]);
 for(const entry of entries)entry.actions=warnings.get(entry.sourceRef)??entry.actions;
 return {of:{id:ofId,number:material.number},version:coverageFingerprint({material:material.version,service:service.version,state,lines,materialPrices,entries}),entries,state,materialPrices,suppliers:material.suppliers as Array<{id:string;name:string}>,material,service,lines,offers};
}
export function planningProcurementDto(current:Awaited<ReturnType<typeof readPlanningProcurementTx>>,canReadPrices=false){
 const entries=current.entries.map(({price,currency,needId:_needId,destinationId:_destinationId,articleId,...entry})=>{
  if(!canReadPrices||entry.kind!=='MATIERE')return entry;
  const offers=current.offers.filter(o=>o.article_id===articleId&&matchesMaterialUnit(o,entry.unit));
  const history=current.materialPrices.filter(p=>p.articleId===articleId);
  const materialPrices=[
   ...offers.flatMap(offer=>{
    const last=history.find(p=>p.supplierId===offer.supplier_id&&p.unit===offer.unit);
    const reference=last??offer;
    return reference.price===null?[]:[{supplierId:offer.supplier_id,catalogueId:offer.id,unit:offer.unit,price:reference.price,
      currency:reference.currency,source:last?'HISTORIQUE':'CATALOGUE'}];
   }),
   ...history.filter(p=>p.unit===entry.unit).map(({supplierId,unit,price,currency})=>({supplierId,unit,price,currency,catalogueId:null,source:'HISTORIQUE'})),
   ...(price!==null&&entry.supplierId?[{supplierId:entry.supplierId,catalogueId:null,unit:entry.unit,price,currency,source:'DEFINITION'}]:[]),
  ];
  return {...entry,materialPrices};
 });
 return {of:current.of,version:current.version,suppliers:current.suppliers,entries};
}
export async function readPlanningProcurement(ofId:number,canReadPrices=false){const tx=await pool.connect();try{await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const value=planningProcurementDto(await readPlanningProcurementTx(tx,ofId),canReadPrices);await tx.query('COMMIT');return value;}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}}
export async function savePlanningProcurement(ofId:number,body:z.infer<typeof savePlanningProcurementSchema>,audit:AuditContext,canPurchase:boolean){
 return consumableCommand({ofId},'PLANNING_SUPPLY_PREPARATION',body,audit,tx=>savePlanningProcurementTx(tx,ofId,body,audit,canPurchase));
}
export async function savePlanningProcurementTx(tx:PoolClient,ofId:number,body:z.infer<typeof savePlanningProcurementSchema>,audit:AuditContext,canPurchase:boolean){
  const current=await readPlanningProcurementTx(tx,ofId);
  if(current.version!==body.expectedVersion)throw new HttpError(409,'PLANNING_SUPPLY_CHANGED','Les besoins, le stock ou les achats ont changé. Actualisez la préparation.');
  if(['TERMINE','CLOTURE','ANNULE'].includes(current.material.executionStatus))
    throw new HttpError(409,'OF_CLOSED','Les achats de cet OF terminé ou annulé restent consultables.');
  if(current.service.coveredByOfId)throw new HttpError(409,'OF_COVERED_BY_CONSOLIDATION','Préparez les achats dans l’OF de regroupement.');
  const entries=current.entries.filter(e=>body.scope==='material'?e.kind==='MATIERE':body.scope==='treatment'?e.kind==='PRESTATION'&&e.operationId===body.operationId:true);
  if(new Set(body.entries.map(e=>e.key)).size!==body.entries.length||body.entries.length!==entries.length||body.entries.some(e=>!entries.some(row=>row.key===e.key)))throw new HttpError(422,'PLANNING_SUPPLY_INVALID','Relisez les besoins de cet OF.');
  const saved:PlanningSupplyState['entries']=current.state?.entries.filter(e=>!entries.some(selected=>selected.key===e.key))??[];
  const createdOrders:Array<{id:string;code:string}>=[];
  for(let input of body.entries){
   const entry=current.entries.find(e=>e.key===input.key)!;
   if(input.supplierId&&!current.suppliers.some(s=>s.id===input.supplierId))throw new HttpError(422,'PLANNING_SUPPLIER_INVALID','Choisissez un fournisseur actif.');
   const offer=input.catalogueId?current.offers.find(o=>o.id===input.catalogueId&&o.article_id===entry.articleId&&o.supplier_id===input.supplierId):null;
   if(input.catalogueId&&(!offer||entry.kind==='MATIERE'&&!matchesMaterialUnit(offer,entry.unit)))throw new HttpError(422,'PLANNING_OFFER_INVALID','Les conditions fournisseur ne sont plus applicables.');
   const actions=[...entry.actions],orders=[...entry.orders],unit=offer?.unit??entry.unit;
   if(entry.kind==='MATIERE'&&canPurchase){
    await tx.query(`UPDATE public.ordres_fabrication SET technical_preparation=COALESCE(technical_preparation,'{}'::jsonb)||jsonb_build_object('material_supplier_choices',COALESCE(technical_preparation->'material_supplier_choices','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)) WHERE id=$1`,[ofId,entry.sourceRef,JSON.stringify({version:current.material.technicalVersion,supplierId:input.supplierId,destinationId:entry.destinationId})]);
   }

   const anchor=current.lines.filter(l=>l.source_ref===entry.sourceRef).map(l=>l.created_at).sort()[0]??new Date().toISOString();
   const physicalNeed=current.material.needs.find(n=>n.key===entry.sourceRef);
   const awaitingMaterial=entry.kind==='MATIERE'&&physicalNeed&&physicalNeed.required>physicalNeed.consumed+physicalNeed.reserved;
   if(awaitingMaterial&&!input.due)input={...input,due:defaultProcurementDay(anchor)};
   if(awaitingMaterial&&input.due&&input.due!==entry.due&&input.due<parisDay(new Date(Date.parse(anchor)+86400000).toISOString()))throw new HttpError(422,'MATERIAL_FORECAST_TOO_EARLY','Prévoir au minimum 24 h après la création du brouillon matière.');
   if(entry.missing>0&&current.material.technicalHash&&!(body.deferMaterialPurchase&&entry.kind==='MATIERE')){
    const materialNeed=entry.kind==='MATIERE'?current.material.needs.find(n=>n.key===entry.sourceRef):undefined;
    const lastPrice=materialNeed&&current.materialPrices.find(p=>p.articleId===entry.articleId&&p.supplierId===input.supplierId&&p.unit===unit);
    if(!input.due)actions.push(entry.kind==='PRESTATION'?'Renseigner le retour prévu pour dater la suite.':'Renseigner la disponibilité prévue de la matière.');
    if(!input.supplierId)actions.push('Besoin d’achat conservé : choisir le fournisseur pour générer la commande brouillon.');
    else if(!canPurchase)actions.push('Faire préparer le brouillon par une personne habilitée aux achats.');
    else if(!current.material.technicalHash||!entry.articleId||!unit||entry.kind==='PRESTATION'&&(!entry.operationId||!isSubcontractPieceUnit(unit)))actions.push('Compléter l’article, l’unité ou la phase avant de générer le brouillon.');
    else if(materialNeed?.supplyMode==='CUSTOMER')actions.push('Matière client : préparer un appel client, sans achat fournisseur.');
    else if(materialNeed?.purchaseRequiresBarReview)actions.push('Vérifiez les barres en stock avant d’acheter.');
    else if(materialNeed&&(materialNeed.blockers.length||current.material.previousNeeds.length))actions.push('Complétez la définition matière ou rapprochez les anciens engagements avant d’acheter.');
    else if(entry.kind==='MATIERE'&&current.material.needs.find(n=>n.key===entry.sourceRef)?.futureSupplies.some(s=>!s.reasons.length&&s.available>0))actions.push('Un achat attendu existe : le rapprocher du besoin avant de créer un autre brouillon.');
    else {
     const need=materialNeed;
     const coefficient=need?offer?.coefficient??1:1;
     const catalogue=offer??(input.supplierId===need?.supplierId?need?.catalog:null);
     const pack=offer?.pack??(need&&offer?.unit!==entry.unit&&offer&&isPurchasePieceUnit(offer.unit)?1:null)
       ??(catalogue&&'lot_achat' in catalogue?catalogue.lot_achat:null);
     const minimum=offer?.moq??(catalogue&&'moq' in catalogue?catalogue.moq:null);
     const quantity=need?purchaseQuantity(Math.ceil(entry.missing/coefficient*1000-1e-8)/1000,minimum,pack).ordered:entry.missing;
     const created=await createMaterialDraftsTx(tx,[{ofId,sourceRef:entry.sourceRef,needId:entry.needId,articleId:entry.articleId!,designation:entry.label,
      supplierId:input.supplierId,...(need&&entry.unit?{stockUnit:entry.unit,coefficient}:{}),currency:lastPrice?.currency??offer?.currency??(input.supplierId===entry.supplierId?entry.currency:'EUR'),destinationId:entry.destinationId,unit:unit!,quantity,assigned:entry.kind==='MATIERE'?entry.missing:0,price:lastPrice?.price??offer?.price??(input.supplierId===entry.supplierId?entry.price:null),due:input.due,
      catalogueId:offer?.id,type:entry.kind==='PRESTATION'?'SOUS_TRAITANCE':'MATIERE',operation:entry.operationId?current.material.operations.find(o=>o.id===entry.operationId)?.label??entry.label:entry.label,requirements:need?[need.requirements.grade,need.requirements.condition,...need.requirements.certificates,...need.requirements.manualChecks,...Object.entries(need.requirements.dimensions).map(([key,value])=>`${key}: ${value} mm minimum`)].filter((v):v is string=>!!v):[],
      ...(entry.kind==='MATIERE'?{allocations:[{needId:entry.needId,sourceRef:entry.sourceRef,ofId,assigned:entry.missing}]}:{subcontract:{operationId:entry.operationId!,materialOriginId:current.service.origins.length===1?current.service.origins[0].id:null,
       snapshot:{purchase:current.service.purchases.find(p=>p.id===entry.sourceRef),planningForecast:true,unit:unit!,quantity:entry.missing,technicalHash:current.material.technicalHash}}})} satisfies MaterialDraftLine],audit);
     orders.push(...created);createdOrders.push(...created);actions.push('Commande fournisseur en brouillon : prix, exigences et origines à confirmer avant validation.');
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
  await tx.query("INSERT INTO public.planning_recalculation_jobs(entity_table,entity_id,source_revision) SELECT 'ordres_fabrication',$1,revision FROM public.planning_central_settings WHERE singleton",[String(ofId)]);
  return {...planningProcurementDto(await readPlanningProcurementTx(tx,ofId)),messages:saved.filter(e=>entries.some(entry=>entry.key===e.key)).flatMap(e=>e.actions),orders:createdOrders};
}

/** Called after the technical snapshot is frozen, while the caller holds Planning then OF. */
export async function prepareAutomaticPlanningPurchasesTx(tx:PoolClient,ofId:number,audit:AuditContext,canPurchase:boolean,stockReview?:{reserve:boolean;deplete:boolean;reviewedSources:ReadonlySet<string>}){
 if(stockReview&&await materialWorkflowEnabled(tx))await applyReviewedStockTx(tx,ofId,audit,stockReview);
 const current=await readPlanningProcurementTx(tx,ofId);
 if(!current.material.technicalHash||current.service.coveredByOfId||!current.material.needs.length)return null;
 const raw=(await tx.query("SELECT technical_preparation->'planning_supply' AS state FROM public.ordres_fabrication WHERE id=$1",[ofId])).rows[0]?.state;
 const carry=raw?.technicalVersion===current.material.technicalVersion&&raw?.technicalHash===null?raw.entries:[];
 const body={expectedVersion:current.version,idempotencyKey:'00000000-0000-4000-8000-000000001836',scope:'material' as const,entries:current.entries.filter(entry=>entry.kind==='MATIERE').map(entry=>{
  const prior=Array.isArray(carry)?carry.find((p:{key:string})=>p.key===entry.key):null;
  const proposedSupplier=prior?prior.supplierId:entry.supplierId;
  const supplierId=current.suppliers.some(s=>s.id===proposedSupplier)?proposedSupplier:null;
  const proposedCatalogue=prior?prior.catalogueId:entry.catalogueId;
  const catalogueId=current.offers.some(o=>o.id===proposedCatalogue&&o.supplier_id===supplierId&&o.article_id===entry.articleId&&matchesMaterialUnit(o,entry.unit))?proposedCatalogue:null;
  return {key:entry.key,due:prior?.due??entry.due,supplierId,catalogueId};
 })};
 const result=await savePlanningProcurementTx(tx,ofId,savePlanningProcurementSchema.parse(body),audit,canPurchase);
 await preparationAudit(tx,audit,ofId,'production.preparation.procurement.automatic',{orders:result.orders,canPurchase});
 return result;
}

/** The user has approved the material summary. Recompute FIFO under the OF
 * and lot locks and use the same stock commands as the manual workflow. */
async function applyReviewedStockTx(tx:PoolClient,ofId:number,audit:AuditContext,rights:{reserve:boolean;deplete:boolean;reviewedSources:ReadonlySet<string>}){
 const preview=await readMaterialTx(tx,ofId,true);
 if(!preview.technicalHash||!preview.technicalVersion||preview.previousNeeds.length||!['BROUILLON','PLANIFIE'].includes(preview.executionStatus))return;
 for(const need of preview.needs){
  if(!canReviewMaterial(need)||!rights.reviewedSources.has(need.key))continue;
  await saveMaterialConfigurationTx(tx,ofId,preview.technicalVersion,preview.technicalHash,need,{
   operationId:need.operationId!,requirements:need.requirements,debitRule:need.debitRule!,supplyMode:need.supplyMode,
   allowPartial:false,supplierId:need.supplierId,destinationId:need.destinationId,
  },need.required,audit.user_id);
  await linkUnassignedMaterialPurchasesTx(tx,ofId,need.key,preview.technicalVersion,need.promises.map(p=>p.command_id),audit);
  await preparationAudit(tx,audit,ofId,'production.of.material.reviewed_from_preparation',{sourceRef:need.key,operationId:need.operationId,requirements:need.requirements,debitRule:need.debitRule});
 }
 if(!rights.reserve)return;
 const current=await readMaterialTx(tx,ofId);
 const key=randomUUID();
 for(const initial of current.needs){
  const live=await readMaterialTx(tx,ofId);
  const need=live.needs.find(n=>n.key===initial.key);
  if(!need?.id||!need.operationId||need.blockers.length)continue;
  for(const selection of need.selections){
   const lot=need.candidates.find(c=>c.lot.batchId===selection.batchId)?.lot;
   if(!lot)continue;
   const result=await reserveMaterialSelectionTx(tx,ofId,live.number,need,lot,selection.quantity,key,audit);
   if(rights.deplete&&need.debitRule?.form==='UNIT'&&need.unit&&isSubcontractPieceUnit(need.unit)){
    await consumeMaterialReservationTx(tx,{reservationId:result.reservation.id,ofId,operationId:need.operationId,quantity:selection.quantity,
     expectedVersion:result.reservation.row_version,idempotencyKey:`${key}:issue:${result.reservation.id}`,reason:`Sortie de bruts unitaires pour ${live.number}`},audit);
   }
  }
 }
}

export async function assertStockReviewVersionTx(tx:PoolClient,ofId:number,version:string){
 const current=await readPlanningProcurementTx(tx,ofId);
 const lotIds=[...new Set(current.material.needs.flatMap(n=>n.candidates.map(c=>c.lot.id)))];
 await tx.query('SELECT id FROM public.lots WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[lotIds]);
 const locked=await readPlanningProcurementTx(tx,ofId);
 if(locked.version!==version)
  throw new HttpError(409,'PLANNING_SUPPLY_CHANGED','Le stock ou les achats ont changé. Vérifiez la nouvelle proposition avant de valider.');
 return new Set(locked.material.needs.filter(canReviewMaterial).map(need=>need.key));
}
