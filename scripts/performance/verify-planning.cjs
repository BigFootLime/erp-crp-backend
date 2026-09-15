const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {connectIsolated}=require('./bootstrap-isolated.cjs');
async function main(){
  process.env.DATABASE_URL='postgresql://cerp_e2e@127.0.0.1:55970/cerp_test';
  const guard=await connectIsolated();await guard.end();
  const {runtime}=require('./runtime.cjs');
  const {readCentralSnapshot}=require('../../dist/module/planning/repository/planning-central.repository.js');
  const {schedule}=require('../../dist/module/planning/domain/central-scheduler.js');
  const pool=require('../../dist/config/database.js').default;
  const {request,snapshot}=require('./planning-http.cjs'),tokens=JSON.parse(fs.readFileSync(path.join(runtime,'sessions.json'),'utf8')),token=tokens[16];
  const from='2026-09-01T00:00:00Z',to='2027-01-01T00:00:00Z',checks=[];
  try{
    const full=await readCentralSnapshot({from,to,limit:10000,include_coverage:false});
    assert.equal(full.tasks.length,10000);assert.equal(full.resources.length,50);assert.equal(full.nextCursor,null);
    const task=full.tasks.find(t=>t.ofNumber==='PERF-970-0001'&&t.label==='Phase 10');assert(task);
    for(const change of [
      {taskId:task.id,expectedVersion:task.version,earliestStart:'2026-11-04T08:00:00Z'},
      {taskId:task.id,expectedVersion:task.version,earliestStart:'2026-11-04T08:00:00Z',autoAssign:true},
      {taskId:task.id,expectedVersion:task.version,earliestStart:'2026-11-04T08:00:00Z',resourceIds:[task.eligibleResourceIds.at(-1)]},
    ]){
      const expected=schedule({...full,from,requested:[change]});
      const actual=await request(token,'/planning/v2/simulations',{from,to,revision:full.revision,changes:[change]},randomUUID());
      assert.deepEqual(actual.result.changes,expected.changes);assert.deepEqual(actual.result.conflicts,expected.conflicts);
    }
    checks.push('Resource-scoped calculations equal full 10000-task calculation for fixed, automatic and changed resource');
    const fingerprint=async()=> (await pool.query(`SELECT
      (SELECT md5(string_agg(id::text||start_ts::text||end_ts::text||COALESCE(machine_id::text,''),',' ORDER BY id)) FROM public.planning_events) AS events,
      (SELECT md5(string_agg(id::text||COALESCE(machine_id::text,''),',' ORDER BY id)) FROM public.of_operations) AS assignments,
      (SELECT count(*)::int FROM public.planning_simulations) AS simulations`)).rows[0];
    const before=await fingerprint();
    const preview=await request(token,'/planning/v2/preview',{from,to,revision:full.revision,earliestStart:'2026-10-01T06:00:00Z',autoAssign:true});
    assert.equal(preview.examined,10000);assert.equal(preview.readOnly,true);assert.deepEqual(await fingerprint(),before);
    checks.push('Global preview leaves commitments, assignments and simulation records unchanged');
    const first=await snapshot(token,{placement:'placed',limit:'1000'});
    const input={from,to,revision:full.revision,changes:[{taskId:task.id,expectedVersion:task.version,earliestStart:'2026-11-04T08:00:00Z'}]};
    const simulateKey=randomUUID(),simulation=await request(token,'/planning/v2/simulations',input,simulateKey);
    assert.deepEqual(await request(token,'/planning/v2/simulations',input,simulateKey),simulation);
    const applyKey=randomUUID(),applied=await request(token,`/planning/v2/simulations/${simulation.id}/apply`,{revision:simulation.revision},applyKey);
    assert.deepEqual(await request(token,`/planning/v2/simulations/${simulation.id}/apply`,{revision:simulation.revision},applyKey),applied);
    checks.push('Simulation and application retries are idempotent');
    const second=await snapshot(token,{placement:'placed',limit:'1000',cursor:first.nextCursor,snapshot_revision:first.revision});
    assert.equal(second.revision,first.revision);assert.equal(second.stale,true);assert.equal(second.total,first.total);
    const ids=new Set(first.tasks.map(t=>t.id));for(const task of second.tasks)assert(!ids.has(task.id));
    checks.push('Pagination remains stable and marks the old snapshot stale after a real commit');
    const obsolete=await request(token,'/planning/v2/simulations',{...input,changes:[{...input.changes[0],earliestStart:'2026-11-05T08:00:00Z'}]},randomUUID()).then(()=>null,e=>e);
    assert.equal(obsolete.status,409);checks.push('Old revision cannot create another applicable simulation');
    fs.writeFileSync(path.join(runtime,'correctness.json'),JSON.stringify({at:new Date().toISOString(),checks},null,2));console.log(checks.join('\n'));
  }finally{await pool.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
