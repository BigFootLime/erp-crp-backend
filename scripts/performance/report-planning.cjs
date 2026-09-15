const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const runtime=path.resolve(__dirname,'../../../performance-runtime');
const read=name=>JSON.parse(fs.readFileSync(path.join(runtime,name),'utf8'));
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const percentile=(values,p)=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.ceil(sorted.length*p)-1]:null;};
const distribution=values=>({samples:values.length,p50:percentile(values,.5),p95:percentile(values,.95),max:Math.max(...values)});
const campaigns=[1,2,3].map(i=>read(`http-campaign-${i}-summary.json`)),browser=read('browser-summary.json'),environment=read('api-environment.json');
for(const run of campaigns){assert.equal(run.config.durationSeconds,1800);assert.equal(run.config.users,20);assert.equal(run.config.api.buildSha256,environment.buildSha256);assert(Date.parse(run.completedAt)-Date.parse(run.config.startedAt)>=1800000);}
assert.equal(browser.runs,100);assert.equal(browser.errors.length,0);
assert.equal(browser.apiBuildSha256,environment.buildSha256);
assert(browser.frontendBuildSha256,'The browser evidence must identify the frontend build');
const browserRows=fs.readFileSync(path.join(runtime,'browser.ndjson'),'utf8').trim().split('\n').map(JSON.parse).slice(-100);
assert.equal(browserRows.length,100);assert.equal(percentile(browserRows.map(r=>r.loadMs),.95),browser.p95);
assert(browserRows.every(r=>r.allVisiblePagesLoaded),'Browser timing must cover all visible pages');
const browserCommand=read('browser-command-smoke.json');
assert(browserCommand.persisted&&browserCommand.dragCancellationPreservedCommitment&&browserCommand.errors.length===0,'The browser command flow must pass');
const startedAt=campaigns[0].config.startedAt,completedAt=campaigns.at(-1).completedAt;
assert(browser.startedAt>=startedAt&&browser.completedAt<=completedAt,'Cold browser loads must run during the concurrent campaigns');
const serverRows=fs.readFileSync(path.join(runtime,'api-metrics-final.ndjson'),'utf8').trim().split('\n').map(JSON.parse)
  .filter(r=>r.at>=startedAt&&r.at<=completedAt);
assert(serverRows.length>=1000,'The 90-minute API resource trace must be present');
const mib=bytes=>bytes/1024/1024;
const resourcesFor=run=>{
  const samples=serverRows.filter(r=>r.at>=run.config.startedAt&&r.at<=run.completedAt);
  assert(samples.length>=350,'Each 30-minute campaign requires a complete 5-second resource trace');
  return {campaign:run.config.campaign,samples:samples.length,
    rssMiB:distribution(samples.map(r=>mib(r.rss))),mainHeapMiB:distribution(samples.map(r=>mib(r.heap))),
    apiCpuPercent:distribution(samples.map(r=>r.cpuPercent)),eventLoopP95Ms:distribution(samples.map(r=>r.eventLoopP95Ms)),
    eventLoopMaxMs:Math.max(...samples.map(r=>r.eventLoopMaxMs))};
};
const firstTen=serverRows.filter(r=>Date.parse(r.at)<Date.parse(startedAt)+600000);
const lastTen=serverRows.filter(r=>Date.parse(r.at)>Date.parse(completedAt)-600000);
const resources={intervalSeconds:5,scope:'API process including worker RSS and CPU; V8 heap is the main thread only. CPU 100% means one logical core. PostgreSQL and whole-host CPU are not sampled. Event-loop monitor resolution: 20 ms.',
  campaigns:campaigns.map(resourcesFor),firstTenMinutesMedianRssMiB:percentile(firstTen.map(r=>mib(r.rss)),.5),
  lastTenMinutesMedianRssMiB:percentile(lastTen.map(r=>mib(r.rss)),.5),
  firstTenMinutesMedianHeapMiB:percentile(firstTen.map(r=>mib(r.heap)),.5),lastTenMinutesMedianHeapMiB:percentile(lastTen.map(r=>mib(r.heap)),.5)};
const sqlRows=read('sql-profile-final.json');
const sql={scope:'Successful SQL query timings accumulated since this API process started, including warm-up and browser validation. Values include client query execution time; they are not PostgreSQL CPU measurements.',
  queryCount:sqlRows.reduce((sum,r)=>sum+r.count,0),topByTotalTime:sqlRows.slice(0,10).map(r=>({id:r.id,statement:r.statement,count:r.count,totalMs:r.totalMs,meanMs:r.totalMs/r.count,maxMs:r.maxMs})),snapshotExplain:read('snapshot-explain.json')};
const rows=campaigns.flatMap((run,i)=>{
  const samples=fs.readFileSync(path.join(runtime,`http-campaign-${i+1}.ndjson`),'utf8').trim().split('\n').map(JSON.parse);
  assert(samples.every(r=>r.at>=run.config.startedAt&&r.at<=run.completedAt),'A campaign file must not contain rows from an earlier run');
  assert.equal(samples.length,Object.values(run.metrics).reduce((sum,m)=>sum+m.count,0),'Raw samples and the campaign summary must agree');
  return samples;
});
for(const run of campaigns){
  const active=rows.filter(r=>r.at>=run.config.startedAt&&r.at<=run.completedAt);
  assert.equal(new Set(active.map(r=>r.actor)).size,20,'All 20 sessions must participate in every campaign');
  assert(active.filter(r=>r.metric==='global_simulation').every(r=>r.examined===10000&&r.requested===2000&&r.feasible),'Global previews must process the complete feasible fixture');
}
assert(rows.filter(r=>r.metric==='local_recalculation'&&r.ok).every(r=>r.changed>0),'Never validate a no-op benchmark');
const budgets={saved_move:1000,global_simulation:10000,local_recalculation:2000};
const acceptance=Object.fromEntries(Object.entries(budgets).map(([metric,budgetMs])=>[metric,{budgetMs,
  passed:campaigns.every(c=>c.metrics[metric].p95<=budgetMs&&c.metrics[metric].success>0),
  samples:rows.filter(r=>r.metric===metric&&r.ok).length,p50:percentile(rows.filter(r=>r.metric===metric&&r.ok).map(r=>r.ms),.5),
  p95:percentile(rows.filter(r=>r.metric===metric&&r.ok).map(r=>r.ms),.95),p99:percentile(rows.filter(r=>r.metric===metric&&r.ok).map(r=>r.ms),.99)}]));
acceptance.usable_browser={budgetMs:3000,passed:browser.p95<=3000,samples:100,p50:browser.p50,p95:browser.p95,p99:browser.p99};
const failures=rows.filter(r=>!r.ok),finalStatus=Object.values(acceptance).every(x=>x.passed)&&failures.length===0?'PASS':'FAIL';
fs.writeFileSync(path.join(runtime,'browser-final.ndjson'),browserRows.map(r=>JSON.stringify(r)).join('\n')+'\n');
fs.writeFileSync(path.join(runtime,'api-campaign-metrics.ndjson'),serverRows.map(r=>JSON.stringify(r)).join('\n')+'\n');
const proofNames=['http-campaign-1.ndjson','http-campaign-2.ndjson','http-campaign-3.ndjson','browser-final.ndjson','browser-command-smoke.json','correctness.json','api-environment.json','snapshot-explain.json','api-campaign-metrics.ndjson','sql-profile-final.json','backend-tests.log','frontend-tests.log'];
const files=proofNames.map(name=>({name,sha256:sha(fs.readFileSync(path.join(runtime,name)))}));
const evidence={status:finalStatus,generatedAt:new Date().toISOString(),environment,acceptance,failures,campaigns,browser,browserCommand,resources,sql,correctness:read('correctness.json'),
  method:'Nearest-rank percentiles of successful operations; failed requests and optimistic retries reported separately. Browser: fresh context with HTTP cache disabled; real authenticated API and isolated PostgreSQL.',
  scope:'COMMIT activation; synthetic routing, qualified resources and dependency chains. Local recalculation means simulation of move consequences, not the asynchronous material/learning projection worker.',
  source:{httpHarnessSha256:sha(fs.readFileSync(path.join(__dirname,'planning-http.cjs'))),fixtureGeneratorSha256:sha(fs.readFileSync(path.join(__dirname,'seed-planning.cjs'))),
    browserHarnessSha256:sha(fs.readFileSync(path.resolve(__dirname,'../../../frontend/scripts/planning-performance.cjs'))),
    backendLockSha256:sha(fs.readFileSync(path.resolve(__dirname,'../../package-lock.json'))),
    frontendLockFile:'pnpm-lock.yaml',frontendLockSha256:sha(fs.readFileSync(path.resolve(__dirname,'../../../frontend/pnpm-lock.yaml')))},files};
const raw=JSON.stringify(evidence,null,2);
fs.writeFileSync(path.join(runtime,'performance-evidence.json'),raw);
const frontendDocs=path.resolve(__dirname,'../../../frontend/docs/planning');
fs.writeFileSync(path.join(frontendDocs,'performance-970-evidence.json'),raw);
// Whitelist only synthetic timing records. Never package credentials, JWTs or application request bodies.
const samples=JSON.stringify({http:rows,browser:browserRows,apiResources:serverRows});
fs.writeFileSync(path.join(frontendDocs,'performance-970-samples.json.gz'),zlib.gzipSync(samples,{level:9}));
console.log(JSON.stringify({status:finalStatus,acceptance,failedRequests:failures.length,optimisticConflicts:rows.filter(r=>r.metric==='optimistic_conflict').length},null,2));
if(finalStatus!=='PASS')process.exitCode=1;
