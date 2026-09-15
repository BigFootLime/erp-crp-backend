import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { schedule } from '../domain/central-scheduler';
import type { ScheduleResult } from '../types/planning-central.types';
import { HttpError } from '../../../utils/httpError';

type Input = Omit<Parameters<typeof schedule>[0], 'signal'>;
type Job = { input: Input; resolve: (result: ScheduleResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; cleanup: () => void };
type Slot = { worker: Worker; job: Job | null; retiring?:boolean };
const slots: Slot[] = [], queue: Job[] = [];
const capacity = 2, maximumQueue = 16;
const workerSource = `
  const {parentPort,workerData}=require('node:worker_threads');
  if(workerData.endsWith('.ts')) {
    const ts=require('typescript'),fs=require('node:fs');
    require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{
      compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}
    }).outputText,file);
  }
  const {schedule}=require(workerData);
  parentPort.on('message',input=>{try {parentPort.postMessage({result:schedule(input)});}catch(error){parentPort.postMessage({error:error.message});}});
`;
function finish(slot: Slot, error?: Error, result?: ScheduleResult) {
  const job = slot.job;
  if (!job) return;
  slot.job = null; clearTimeout(job.timer); job.cleanup(); slot.worker.unref();
  if (error) job.reject(error); else job.resolve(result!);
  dispatch();
}
function remove(slot: Slot, error: Error) {
  const index = slots.indexOf(slot);
  if (index < 0||slot.retiring) return;
  slot.retiring=true;
  finish(slot,error);
  // Keep the slot occupied until termination has actually completed. Rapid
  // cancellations must not create an unbounded number of retiring workers.
  void slot.worker.terminate().finally(()=>{
    const index=slots.indexOf(slot);if(index>=0)slots.splice(index,1);dispatch();
  });
}
function dispatch() {
  while (queue.length) {
    let slot = slots.find(s=>!s.job&&!s.retiring);
    if (!slot && slots.length < capacity) {
      const extension = __filename.endsWith('.ts') ? '.ts' : '.js';
      const worker = new Worker(workerSource,{eval:true,workerData:path.join(__dirname,'../domain/central-scheduler'+extension)});
      slot = {worker,job:null}; slots.push(slot);
      const current = slot;
      worker.on('message',(message: {result?:ScheduleResult;error?:string}) => finish(current,message.error ? new HttpError(422,'PLANNING_CALCULATION_FAILED',message.error) : undefined,message.result));
      worker.on('error',()=>remove(current,new HttpError(503,'PLANNING_WORKER_FAILED','Le calcul doit être relancé.')));
      worker.on('exit',()=>{if(slots.includes(current)) remove(current,new HttpError(503,'PLANNING_WORKER_STOPPED','Le calcul a été interrompu.'));});
    }
    if (!slot) break;
    slot.job = queue.shift()!; slot.worker.ref(); slot.worker.postMessage(slot.job.input);
  }
}
/** Queue wait is part of the deadline; no unbounded CPU work on Express's event loop. */
export function computeSchedule(input: Input, signal?: AbortSignal, timeoutMs = 8000): Promise<ScheduleResult> {
  if (signal?.aborted) return Promise.reject(new HttpError(499,'PLANNING_CANCELLED','Calcul annulé.'));
  if (input.tasks.length <= 250) return Promise.resolve().then(()=>schedule(input));
  if (queue.length >= maximumQueue) return Promise.reject(new HttpError(503,'PLANNING_BUSY','Le planning est occupé. Réessayez.'));
  return new Promise((resolve,reject)=>{
    const cancel = (error: Error) => {
      const waiting = queue.indexOf(job);
      if (waiting >= 0) { queue.splice(waiting,1); clearTimeout(job.timer); job.cleanup(); reject(error); }
      else { const slot = slots.find(s=>s.job===job); if (slot) remove(slot,error); }
    };
    const onAbort = () => cancel(new HttpError(499,'PLANNING_CANCELLED','Calcul annulé.'));
    const job: Job = {input,resolve,reject,timer:setTimeout(()=>cancel(new HttpError(503,'PLANNING_TIMEOUT','Le délai de calcul est dépassé.')),timeoutMs),
      cleanup:()=>signal?.removeEventListener('abort',onAbort)};
    signal?.addEventListener('abort',onAbort,{once:true});
    queue.push(job); dispatch();
  });
}
