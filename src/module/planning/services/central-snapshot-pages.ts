import {randomUUID} from 'node:crypto';
import pool from '../../../config/database';
import {HttpError} from '../../../utils/httpError';
import {readCentralSnapshot} from '../repository/planning-central.repository';
import type {CentralSnapshot} from '../types/planning-central.types';
import type {CentralWindow} from '../validators/planning-central.validators';

type Entry={id:string;key:string;scope:string;expires:number;snapshot:CentralSnapshot};
const entries=new Map<string,Entry>(),loading=new Map<string,Promise<Entry>>();
const ttl=30_000,maxTasks=40_000,maxEntries=16;
let waitingReaders=0;
const obsolete=()=>new HttpError(409,'PLANNING_SNAPSHOT_EXPIRED','La lecture a expiré. Actualisez le planning.');
const scopeOf=(q:CentralWindow)=>JSON.stringify([q.from,q.to,q.search??null,q.of_id??null,q.resource_id??null,q.placement??null]);
function sweep(){
  for(const [id,entry] of entries)if(entry.expires<Date.now())entries.delete(id);
  let total=[...entries.values()].reduce((sum,e)=>sum+e.snapshot.tasks.length,0);
  for(const [id,e] of entries){if(total<=maxTasks&&entries.size<=maxEntries)break;entries.delete(id);total-=e.snapshot.tasks.length;}
}
/** Short lived immutable read pages. Commands always reread canonical SQL state under revision locks. */
export async function readCentralPage(query:CentralWindow,attempt=0,deadline=Date.now()+1000):Promise<CentralSnapshot>{
  if(query.include_coverage)return readCentralSnapshot(query);
  sweep();
  const epoch=(await pool.query<{revision:string;calculated:string|null;activation:CentralSnapshot['activation']}>(`
    SELECT s.revision::text,s.activation,f.calculated_at::text AS calculated FROM public.planning_central_settings s
    LEFT JOIN public.planning_forecast_state f ON f.singleton WHERE s.singleton`)).rows[0];
  if(!epoch)throw new HttpError(503,'PLANNING_NOT_CONFIGURED','Le planning central n’est pas configuré.');
  const scope=scopeOf(query),key=JSON.stringify([scope,epoch.revision,epoch.calculated,epoch.activation]);
  let entry:Entry|undefined,offset=0;
  if(query.cursor?.startsWith('page:')){
    const match=/^page:([0-9a-f-]{36}):(\d+)$/.exec(query.cursor);
    if(!match)throw obsolete();
    entry=entries.get(match[1]);offset=Number(match[2]);
    if(!entry||entry.scope!==scope||offset>entry.snapshot.tasks.length||query.snapshot_revision&&query.snapshot_revision!==entry.snapshot.revision)throw obsolete();
  }else if(query.cursor){
    // Compatibility for callers holding a cursor issued by an older application instance.
    return readCentralSnapshot(query);
  }else{
    if(query.snapshot_revision&&query.snapshot_revision!==epoch.revision)throw obsolete();
    entry=[...entries.values()].find(e=>e.key===key);
    if(!entry){
      let pending=loading.get(key);
      if(!pending){
        if(loading.size>=4){
          const busy=()=>new HttpError(503,'PLANNING_READ_BUSY','Le planning est occupé. Réessayez.');
          if(waitingReaders>=16||Date.now()>=deadline)throw busy();
          waitingReaders++;let timer:NodeJS.Timeout|undefined;
          try{
            await Promise.race([...loading.values()].map(p=>p.then(()=>{},()=>{})).concat([
              new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(busy()),Math.max(1,deadline-Date.now()));})]));
          }finally{waitingReaders--;clearTimeout(timer);}
          return readCentralPage(query,attempt,deadline);
        }
        pending=(async()=>{
          const snapshot=await readCentralSnapshot({...query,limit:10000,cursor:undefined,snapshot_revision:epoch.revision});
          if(snapshot.nextCursor)throw new HttpError(422,'PLANNING_WINDOW_TOO_DENSE','Cette fenêtre dépasse 10 000 opérations. Réduisez la période ou la recherche.');
          const e={id:randomUUID(),key,scope,expires:Date.now()+ttl,snapshot};entries.set(e.id,e);sweep();return e;
        })();loading.set(key,pending);
        void pending.finally(()=>loading.delete(key)).catch(()=>{});
      }
      try {entry=await pending;}
      catch(error){
        if(error instanceof HttpError&&error.code==='PLANNING_SNAPSHOT_OBSOLETE'&&attempt<2&&!query.snapshot_revision)
          return readCentralPage(query,attempt+1,deadline);
        throw error;
      }
    }
  }
  const tasks=entry.snapshot.tasks.slice(offset,offset+query.limit),ids=new Set(tasks.map(t=>t.id));
  return {...entry.snapshot,tasks,activation:epoch.activation,
    stale:entry.snapshot.revision!==epoch.revision||entry.key!==key,
    dependencies:entry.snapshot.dependencies.filter(d=>ids.has(d.predecessorId)||ids.has(d.successorId)),
    nextCursor:offset+query.limit<entry.snapshot.tasks.length?`page:${entry.id}:${offset+query.limit}`:null};
}
