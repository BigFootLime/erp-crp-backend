const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {runtime,credentials}=require('./runtime.cjs');
const origin='http://127.0.0.1:50970/api/v1';
const duration=Number(process.env.PERF_SECONDS??60),campaign=process.env.PERF_CAMPAIGN??'smoke';
const from='2026-09-01T00:00:00Z',to='2027-01-01T00:00:00Z';
const output=path.join(runtime,`http-${campaign}.ndjson`),measurements=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class RequestError extends Error{constructor(status,code){super(`${status}:${code}`);this.status=status;this.code=code;}}
async function request(token,url,body,key){
  const response=await fetch(origin+url,{method:body?'POST':'GET',headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  const data=await response.json();if(!response.ok)throw new RequestError(response.status,data.code??data.error?.code??'HTTP_ERROR');return data;
}
const snapshot=(token,params)=>request(token,'/planning/v2/snapshot?'+new URLSearchParams({from,to,include_coverage:'false',...params}));
function record(value){const row={at:new Date().toISOString(),...value};measurements.push(row);fs.appendFileSync(output,JSON.stringify(row)+'\n');}
async function measured(metric,actor,fn){const start=performance.now();try{const extra=await fn();record({metric,actor,ms:performance.now()-start,ok:true,...extra});}catch(e){record({metric,actor,ms:performance.now()-start,ok:false,status:e.status??null,code:e.code??e.name});}}
async function readWindow(token,index){
  // Complete the visible week with a revision-bound cursor; backlog is an independent first page.
  const date=new Date(Date.parse(from)+(index%4)*7*86400000),end=new Date(+date+7*86400000);
  const params={from:date.toISOString(),to:end.toISOString(),placement:'placed',limit:'1000'};
  const [first,backlog]=await Promise.all([snapshot(token,params),snapshot(token,{placement:'backlog',limit:'250'})]);
  let next=first,count=first.tasks.length,pages=1;const ids=new Set(first.tasks.map(t=>t.id));
  while(next.nextCursor){next=await snapshot(token,{...params,cursor:next.nextCursor,snapshot_revision:first.revision});pages++;for(const t of next.tasks){assert(!ids.has(t.id));ids.add(t.id);}count+=next.tasks.length;}
  assert.equal(count,first.total);assert.equal(first.resources.length,50);
  return {operations:count,backlog:backlog.total,pages};
}
async function move(token,actor,iteration){
  const of=actor-16; // Four disjoint machines and OF chains, still contending on the global revision.
  for(let retry=0;retry<4;retry++){
    try{
      const page=await snapshot(token,{search:`PERF-970-${String(of).padStart(4,'0')}`,limit:'100'});
      const task=page.tasks.find(t=>t.label===(iteration%5===0?'Phase 1':'Phase 10'));assert(task,'move task exists');
      const alternatives=iteration%5===0?['2026-11-02','2026-11-09']:['2026-11-23','2026-11-30'];
      const target=task.committed?.start.startsWith(alternatives[0])?alternatives[1]:alternatives[0];
      const begin=performance.now();
      const simulation=await request(token,'/planning/v2/simulations',{from,to,revision:page.revision,changes:[{taskId:task.id,expectedVersion:task.version,earliestStart:target+'T08:00:00Z'}]},randomUUID());
      assert(simulation.result.feasible,JSON.stringify(simulation.result.conflicts));
      assert(simulation.result.changes.some(c=>c.taskId===task.id&&c.after.start!==c.before?.start),'Every measured move must change its committed date');
      record({metric:'local_recalculation',actor,ms:performance.now()-begin,ok:true,affected:simulation.result.affected.length,changed:simulation.result.changes.length});
      const applyStart=performance.now();
      await request(token,`/planning/v2/simulations/${simulation.id}/apply`,{revision:simulation.revision},randomUUID());
      record({metric:'saved_move',actor,ms:performance.now()-applyStart,ok:true,retries:retry});
      return {retries:retry};
    }catch(e){if(e.status!==409||retry===3)throw e;record({metric:'optimistic_conflict',actor,ok:true,code:e.code});await sleep(150*2**retry+actor*17);}
  }
}
async function preview(token){const status=await request(token,'/planning/v2/status');const result=await request(token,'/planning/v2/preview',{from,to,revision:status.revision,earliestStart:'2026-10-01T06:00:00Z',autoAssign:true});
  assert.equal(result.examined,10000);assert.equal(result.readOnly,true);return {examined:result.examined,requested:result.requested,feasible:result.result.feasible,stale:result.stale};}
async function main(){
  assert(duration>0&&duration<=5400);assert(/^[a-zA-Z0-9_-]+$/.test(campaign));
  const fixture=JSON.parse(fs.readFileSync(path.join(runtime,'fixture.json'),'utf8'));
  const sessionFile=path.join(runtime,'sessions.json');
  const tokens=fs.existsSync(sessionFile)?JSON.parse(fs.readFileSync(sessionFile,'utf8')):[];
  if(!tokens.length){
    for(let i=1;i<=20;i++){const session=await request(null,'/auth/login',{username:`PERF970_${String(i).padStart(2,'0')}`,password:credentials.password});assert(session.token,'real password login');tokens.push(session.token);await sleep(100);}
    fs.writeFileSync(sessionFile,JSON.stringify(tokens),{mode:0o600});
  }
  // Verify the read role cannot simulate before running the load.
  try{await preview(tokens[0]);throw new Error('reader was allowed to simulate');}catch(e){assert.equal(e.status,403);}
  const config={campaign,durationSeconds:duration,users:20,readers:16,planners:4,readerPeriodMs:5000,plannerPeriodMs:15000,plannerStaggerMs:3000,chainMoves:'one in five moves targets the first of ten dependent operations',fixture,
    clientHost:os.hostname(),clientCpu:os.cpus()[0].model,clientNode:process.version,api:JSON.parse(fs.readFileSync(path.join(runtime,'api-environment.json'),'utf8')),
    backendBase:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    trackedDiffHash:createHash('sha256').update(require('node:child_process').execFileSync('git',['-c','core.autocrlf=false','diff','HEAD'],{stdio:['ignore','pipe','ignore']})).digest('hex'),startedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(runtime,`http-${campaign}-config.json`),JSON.stringify(config,null,2));
  const start=performance.now(),deadline=start+duration*1000;
  const progress=setInterval(()=>console.log(`Campaign ${campaign}: ${Math.round((performance.now()-start)/1000)}s, ${measurements.length} samples, ${measurements.filter(r=>r.ok===false).length} failures`),60000);
  await Promise.all(tokens.map(async(token,index)=>{
    await sleep(index<16?index*120:2000+(index-16)*3000);let iteration=0;
    while(performance.now()<deadline){const tick=performance.now();
      if(index<16)await measured('usable_api_window',index+1,()=>readWindow(token,iteration));
      else if(index===19&&iteration%4===0)await measured('global_simulation',index+1,()=>preview(token));
      else await measured('move_flow',index+1,()=>move(token,index+1,iteration));
      iteration++;await sleep(Math.max(0,Math.min(deadline-performance.now(),(index<16?5000:15000)-(performance.now()-tick))));
    }
  }));clearInterval(progress);
  const result={config,completedAt:new Date().toISOString(),metrics:{}};
  for(const metric of [...new Set(measurements.map(r=>r.metric))]){
    const rows=measurements.filter(r=>r.metric===metric),values=rows.filter(r=>r.ok&&Number.isFinite(r.ms)).map(r=>r.ms).sort((a,b)=>a-b);
    const percentile=p=>values.length?values[Math.ceil(values.length*p)-1]:null;
    result.metrics[metric]={count:rows.length,success:rows.filter(r=>r.ok).length,failed:rows.filter(r=>!r.ok).length,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),max:values.at(-1)??null};
  }
  fs.writeFileSync(path.join(runtime,`http-${campaign}-summary.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result.metrics,null,2));
}
module.exports={request,snapshot,readWindow,preview,move};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
