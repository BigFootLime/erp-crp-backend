import {effectivePreparationVersionSql} from '../../production/repository/effective-preparation-version.sql';
import {materialForecastAvailability} from '../domain/material-forecast';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { CentralTask } from '../types/planning-central.types';
import { promiseEnd } from '../domain/external-schedule';

const civilDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Date invalide.');
export const supplyEntrySchema=z.object({key:z.string().min(1).max(200),due:civilDate.nullable(),supplierId:z.string().uuid().nullable(),catalogueId:z.string().uuid().nullable()}).strict();
const savedEntrySchema=supplyEntrySchema.extend({kind:z.enum(['MATIERE','PRESTATION']),sourceRef:z.string().uuid(),operationId:z.string().uuid().nullable(),label:z.string(),missing:z.number().nonnegative(),orders:z.array(z.object({id:z.string(),code:z.string()})),actions:z.array(z.string())});
const stateSchema=z.object({technicalHash:z.string().nullable(),technicalVersion:z.string().nullable(),revisionId:z.string().nullable(),entries:z.array(savedEntrySchema).max(300)});
export type PlanningSupplyState=z.infer<typeof stateSchema>;
export async function readPlanningSupplyStates(tx:Pick<PoolClient,'query'>,ofIds:number[]) {
 const result=new Map<number,PlanningSupplyState>();if(!ofIds.length)return result;
 const {rows}=await tx.query<{id:string;hash:string|null;version:string|null;revision:string|null;state:unknown}>(`SELECT o.id::text,o.technical_snapshot_sha256 AS hash,${effectivePreparationVersionSql("o")}::text AS version,
  (SELECT r.id::text FROM public.of_revisions r WHERE r.of_id=o.id AND r.statut='ACTIVE') AS revision,
  o.technical_preparation->'planning_supply' AS state FROM public.ordres_fabrication o WHERE o.id=ANY($1::bigint[])`,[ofIds]);
 for(const row of rows){const parsed=stateSchema.safeParse(row.state);if(parsed.success&&parsed.data.technicalHash===row.hash&&parsed.data.technicalVersion===row.version&&parsed.data.revisionId===row.revision)result.set(Number(row.id),parsed.data);}
 return result;
}
/** Refresh assumptions against the canonical material/AR/receipt ledgers on every calculation. */
export async function hydratePlanningSupply(tx:Pick<PoolClient,'query'>,tasks:CentralTask[]) {
 const ids=[...new Set(tasks.flatMap(t=>t.ofId?[t.ofId]:[]))],states=await readPlanningSupplyStates(tx,ids);
 const {readMaterialTx}=await import('../../production/repository/of-material.repository');
 const {readMaterialReservationAvailabilityTx}=await import('../../production/repository/material-reservation-availability.repository');
 const {projectMaterialCoverage}=await import('../domain/planning-material-coverage');
 const {materialForecastStart}=await import('../domain/procurement-forecast');
 const now=new Date().toISOString();
 for(const ofId of ids){
  const state=states.get(ofId),ofTasks=tasks.filter(t=>t.ofId===ofId);
  const internal=ofTasks.filter(t=>t.source==='OPERATION'&&!t.external).sort((a,b)=>(a.phase??0)-(b.phase??0));
  if(!internal.length&&!ofTasks.some(t=>t.external))continue;
  const material=await readMaterialTx(tx,ofId),availability=await readMaterialReservationAvailabilityTx(tx,material);
  const coverage=projectMaterialCoverage(material,ofTasks,availability,now);
  const dates=(await tx.query<{source:string;created:string}>(`SELECT b.besoin_ref AS source,min(c.created_at)::text AS created FROM public.commande_fournisseur_ligne_besoin b JOIN public.commande_fournisseur_ligne l ON l.id=b.ligne_id JOIN public.commande_fournisseur c ON c.id=l.commande_id WHERE b.besoin_of_id=$1 AND NOT b.annule AND l.statut_ligne='ACTIVE' AND c.statut<>'ANNULEE' GROUP BY b.besoin_ref`,[ofId])).rows;
  for(const need of material.needs){
   const demand=coverage.demands.find(d=>d.coverage?.sourceRef===need.key)?.coverage;
   const saved=state?.entries.find(e=>e.kind==='MATIERE'&&e.sourceRef===need.key);
   const task=internal.find(t=>t.operationId===need.operationId)??internal.find(t=>t.operationId===saved?.operationId)??internal[0];
   if(!task||!demand)continue;
   const shortage=Math.max(0,need.required-need.consumed-demand.usableReserved);
   if(shortage<=0)continue;
   const anchor=dates.find(d=>d.source===need.key)?.created??now;
   const announced=materialForecastAvailability({now,required:need.required,consumed:need.consumed,reserved:demand.usableReserved,blocked:need.receivedBlocked,preparation:[],promises:need.promises.filter(p=>['ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE','RECUE','CLOTUREE'].includes(p.statut)&&p.article_id===need.articleId&&p.unite===need.unit&&(p.destination_id??null)===need.destinationId&&(p.owner_client_id??null)===need.requirements.ownerClientId).map(p=>({quantity:Math.max(0,p.assigned-p.received),date:p.due}))});
   const confirmed=demand.availableAt??announced.date;
   const ready=confirmed??materialForecastStart(anchor,saved?.due??null,now);
   if(!task.earliestStart||Date.parse(ready)>Date.parse(task.earliestStart))task.earliestStart=ready;
   task.procurementWarnings=[...(task.procurementWarnings??[]),confirmed
    ? `${need.designation} : disponibilité annoncée par le fournisseur le ${confirmed.slice(0,10)}. Réception et libération requises avant démarrage.`
    : `${need.designation} : approvisionnement prévisionnel, 7 jours par défaut et minimum 24 h après le brouillon. À confirmer par l’AR fournisseur et la réception.`];
  }
  for(const task of ofTasks.filter(t=>t.external&&t.commitment!=='DONE')){
   const entry=state?.entries.find(e=>e.kind==='PRESTATION'&&e.operationId===task.operationId);
   if(entry?.due)task.external!.plannedReturnAt=promiseEnd(entry.due,'Europe/Paris');
   task.external!.forecastLeadDays=7;
   const external=task.external!;
   const confirmed=external.fullReadyAt&&external.packages.reduce((sum,p)=>sum+p.planned,0)>=task.quantity
     &&external.packages.every(p=>p.promisedDate||p.returned>=p.planned&&p.released>=p.planned);
   if(!confirmed)task.procurementWarnings=[...(task.procurementWarnings??[]),`${task.label} : délai prévisionnel en attente de l’AR fournisseur. Le brouillon reste ajustable avant le contrôle de sortie d’usinage.`];
  }
  for(const task of ofTasks)task.version=createHash('sha256').update(task.version+JSON.stringify([state??null,material.version])).digest('hex');
 }
}
