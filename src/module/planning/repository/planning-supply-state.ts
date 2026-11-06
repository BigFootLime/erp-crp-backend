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
 const {rows}=await tx.query<{id:string;hash:string|null;version:string|null;revision:string|null;state:unknown}>(`SELECT o.id::text,o.technical_snapshot_sha256 AS hash,o.piece_technique_version_id::text AS version,
  (SELECT r.id::text FROM public.of_revisions r WHERE r.of_id=o.id AND r.statut='ACTIVE') AS revision,
  o.technical_preparation->'planning_supply' AS state FROM public.ordres_fabrication o WHERE o.id=ANY($1::bigint[])`,[ofIds]);
 for(const row of rows){const parsed=stateSchema.safeParse(row.state);if(parsed.success&&parsed.data.technicalHash===row.hash&&parsed.data.technicalVersion===row.version&&parsed.data.revisionId===row.revision)result.set(Number(row.id),parsed.data);}
 return result;
}
/** Operational assumptions only: no stock, supplier promise or canonical schedule is written. */
export async function hydratePlanningSupply(tx:Pick<PoolClient,'query'>,tasks:CentralTask[]) {
 const states=await readPlanningSupplyStates(tx,[...new Set(tasks.flatMap(t=>t.ofId?[t.ofId]:[]))]);
 for(const [ofId,state] of states){
  const internal=tasks.filter(t=>t.ofId===ofId&&t.source==='OPERATION'&&!t.external).sort((a,b)=>(a.phase??0)-(b.phase??0));
  for(const entry of state.entries){
   if(!entry.due||entry.missing<=0)continue;
   const task=entry.kind==='PRESTATION'?tasks.find(t=>t.ofId===ofId&&t.operationId===entry.operationId):internal.find(t=>t.operationId===entry.operationId)??internal[0];
   if(!task)continue;
   const warning=`${entry.label} : date prévue ${entry.due}, à confirmer par les achats et la réception${entry.orders.length?' · '+entry.orders.map(o=>o.code).join(', '):' · fournisseur ou commande à compléter'}.`;
   task.procurementWarnings=[...(task.procurementWarnings??[]),warning];
   if(entry.kind==='PRESTATION'&&task.external)task.external.plannedReturnAt=promiseEnd(entry.due,'Europe/Paris');
   else if(entry.kind==='MATIERE'){
    const date=promiseEnd(new Date(Date.parse(entry.due)-86400000).toISOString().slice(0,10),'Europe/Paris');
    // A future planning assumption never releases a real material reservation.
    if(!task.earliestStart||Date.parse(date)>Date.parse(task.earliestStart))task.earliestStart=new Date(date).toISOString();
   }
  }
  for(const task of tasks.filter(t=>t.ofId===ofId))task.version=createHash('sha256').update(task.version+JSON.stringify(state)).digest('hex');
 }
}
