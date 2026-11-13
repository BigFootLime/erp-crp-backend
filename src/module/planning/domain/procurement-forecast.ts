import {promiseEnd} from './external-schedule';

export const DEFAULT_PROCUREMENT_DAYS=7;
export const MINIMUM_MATERIAL_HOURS=24;
const day=86400000;
export function parisDay(instant:string){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(instant));
  return ['year','month','day'].map(key=>parts.find(p=>p.type===key)!.value).join('-');
}
export function defaultProcurementDay(anchor:string,days=DEFAULT_PROCUREMENT_DAYS){return parisDay(new Date(Date.parse(anchor)+days*day).toISOString());}
export function materialForecastStart(anchor:string,due:string|null,now:string){
  const date=due??defaultProcurementDay(anchor);
  const previous=new Date(Date.parse(date)-day).toISOString().slice(0,10);
  return new Date(Math.max(Date.parse(now),Date.parse(anchor)+MINIMUM_MATERIAL_HOURS*3600000,Date.parse(promiseEnd(previous,'Europe/Paris')))).toISOString();
}
/** Draft quantities follow observed output until the upstream control is closed. */
export function provisionalServiceQuantity(planned:number,predecessors:Array<{status:string;good:number;processed?:number;direct?:boolean}>){
  if(!predecessors.length)return {quantity:planned,final:false};
  const direct=predecessors.filter(p=>p.direct!==false);
  const final=direct.length>0&&direct.every(p=>p.status==='DONE');
  return {quantity:Math.max(0,Math.min(planned,...predecessors.map(p=>p.status==='DONE'?p.good:planned-Math.max(0,(p.processed??p.good)-p.good)))),final};
}
