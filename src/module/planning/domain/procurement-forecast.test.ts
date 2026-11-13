import {describe,it,expect} from 'vitest';
import {defaultProcurementDay,materialForecastStart,provisionalServiceQuantity} from './procurement-forecast';
import {schedule} from './central-scheduler';
import {estimateDuration} from './central-estimation';
import type {CentralTask,Resource} from '../types/planning-central.types';

describe('prévisions approvisionnement #1836',()=>{
 it('prévoit sept jours à partir du brouillon et respecte le jour civil de Paris',()=>{
  expect(defaultProcurementDay('2026-11-06T08:00:00Z')).toBe('2026-11-13');
  expect(defaultProcurementDay('2026-11-06T23:30:00Z')).toBe('2026-11-14');
 });
 it('préserve 24 heures réelles même pendant le changement d’heure',()=>{
  const anchor='2026-03-28T15:00:00Z';
  expect(materialForecastStart(anchor,'2026-03-29',anchor)).toBe('2026-03-29T15:00:00.000Z');
 });
 it('place la matière au début du jour prévu et ne revient pas dans le passé',()=>{
  expect(materialForecastStart('2026-11-06T08:00:00Z','2026-11-13','2026-11-06T08:00:00Z')).toBe('2026-11-12T23:00:00.000Z');
  expect(materialForecastStart('2026-11-01T08:00:00Z','2026-11-08','2026-11-13T09:00:00Z')).toBe('2026-11-13T09:00:00.000Z');
 });
 it('garde la prévision avant pointage puis suit les conformes et les rebuts jusqu’au contrôle terminé',()=>{
  expect(provisionalServiceQuantity(50,[{status:'TODO',good:0,processed:0}])).toEqual({quantity:50,final:false});
  expect(provisionalServiceQuantity(50,[{status:'RUNNING',good:20,processed:22}])).toEqual({quantity:48,final:false});
  expect(provisionalServiceQuantity(50,[{status:'TODO',good:0,processed:0,direct:true},{status:'RUNNING',good:20,processed:23,direct:false}])).toEqual({quantity:47,final:false});
  expect(provisionalServiceQuantity(50,[{status:'DONE',good:47,processed:50}])).toEqual({quantity:47,final:true});
  expect(provisionalServiceQuantity(50,[{status:'DONE',good:0,processed:50}])).toEqual({quantity:0,final:true});
 });
 it('calcule toute la chaîne malgré le stock manquant et un traitement sans AR',()=>{
  const from='2026-11-06T08:00:00Z',available='2026-11-13T08:00:00Z';
  const resource:Resource={id:'poste:recipe',kind:'POSTE',label:'Poste recette',timezone:'Europe/Paris',version:'1',availability:[{start:from,end:'2026-12-31T23:00:00Z'}]};
  const task=(id:string,patch:Partial<CentralTask>={}):CentralTask=>({id,source:'OPERATION',operationId:id,programmingId:null,ofId:1,orderId:1,ofNumber:'RECETTE',reference:'TEST',revision:'A',label:id,view:'cutting',internal:false,internalPurpose:null,quantity:50,good:0,scrap:0,rework:0,released:0,resourceIds:[resource.id],eligibleResourceIds:[resource.id],committed:null,forecast:null,actual:null,commitment:'FORECAST',locked:false,readiness:'READY',blockers:[],earliestStart:null,due:null,priority:0,createdAt:from,version:'1',estimate:estimateDuration({contextKey:id,routingSetupMinutes:0,routingUnitMinutes:1,quantity:50,good:0,scrap:0,rework:0,observations:[]}),...patch});
  const tasks=[task('cut',{earliestStart:available,procurementWarnings:['Matière attendue, brouillon à compléter.']}),task('mill'),task('qc'),task('treatment',{view:'external',external:{packages:[],preparations:[],preparationIssues:['Fournisseur à compléter.'],issues:[],fullReadyAt:null,firstBatchReadyAt:null,forecastLeadDays:7},procurementWarnings:['Traitement prévisionnel.']}),task('pack')];
  const result=schedule({tasks,resources:[resource],from,dependencies:tasks.slice(1).map((t,i)=>({predecessorId:tasks[i].id,successorId:t.id,transferQuantity:null,releasedQuantity:0,lagMinutes:0})),requested:tasks.map(t=>({taskId:t.id,earliestStart:from}))});
  expect(result.feasible).toBe(true);expect(result.changes).toHaveLength(5);
  expect(result.forecasts.cut.start).toBe('2026-11-13T08:00:00.000Z');
  expect(Date.parse(result.forecasts.treatment.end)-Date.parse(result.forecasts.qc.end)).toBe(7*86400000);
  expect(result.forecasts.pack.start).toBe(result.forecasts.treatment.end);
  expect(result.conflicts.every(c=>c.blocking===false)).toBe(true);
 });
});
