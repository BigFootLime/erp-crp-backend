const fs=require('node:fs'),path=require('node:path');
const {connectIsolated}=require('./bootstrap-isolated.cjs');
(async()=>{const db=await connectIsolated();try{
  const source=fs.readFileSync(path.join(__dirname,'../../src/module/planning/repository/planning-central.repository.ts'),'utf8');
  const sql=source.match(/const TASK_QUERY = `([\s\S]*?)`;/)[1];
  const plan=(await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,['2026-09-01T00:00:00Z','2027-01-01T00:00:00Z',null,null,null,null,10001,[],null,false,null])).rows[0]['QUERY PLAN'];
  fs.writeFileSync(path.join(__dirname,'../../../performance-runtime/snapshot-explain.json'),JSON.stringify(plan,null,2));
  console.log(JSON.stringify({planning:plan[0]['Planning Time'],execution:plan[0]['Execution Time']}));
  function visit(p){if(p['Actual Total Time']>10)console.log(p['Node Type'],p['Relation Name']??p['Subplan Name']??'',p['Actual Total Time'],p['Actual Rows'],p['Actual Loops']);(p.Plans??[]).forEach(visit);}visit(plan[0].Plan);
}finally{await db.end()}})().catch(e=>{console.error(e.message);process.exitCode=1});
