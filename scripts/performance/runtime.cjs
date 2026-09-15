const fs=require('node:fs'),path=require('node:path');
const runtime=path.resolve(__dirname,'../../../performance-runtime');
const credentials=JSON.parse(fs.readFileSync(path.join(runtime,'credentials.json'),'utf8'));
Object.assign(process.env,{NODE_ENV:'test',CERP_E2E_ISOLATED:'1',CERP_E2E_MANAGED_STACK:'1',
  DATABASE_URL:'postgresql://cerp_app@127.0.0.1:55970/cerp_test',PORT:'50970',
  FRONTEND_URL:'http://127.0.0.1:51970',BACKEND_URL:'http://127.0.0.1:50970',CORS_ORIGINS:'http://127.0.0.1:51970',
  JWT_SECRET:credentials.jwt,CERP_E2E_RUN_ROOT:runtime,CERP_ROOT:runtime,
  RESEND_API_KEY:'',RESEND_FROM:'',RESEND_API_BASE_URL:'',
  VITE_API_BASE_URL:'/api/v1',VITE_API_PROXY_TARGET:'http://127.0.0.1:50970'});
for(const [key,dir] of Object.entries({CERP_STORAGE_ROOT:'storage',CERP_DOCUMENTS_ROOT:'documents',CERP_GENERATED_ROOT:'generated',
  CERP_INBOUND_ROOT:'inbound',CERP_EXPORTS_ROOT:'exports',CERP_TMP_ROOT:'tmp',CERP_IMAGES_ROOT:'images',CERP_GED_VAULT_ROOT:'ged'})){
  process.env[key]=path.join(runtime,dir);fs.mkdirSync(process.env[key],{recursive:true});
}
module.exports={runtime,credentials};
if(require.main===module){
  if(process.argv.includes('--api')){
    const build=require('node:crypto').createHash('sha256'),dist=path.resolve(__dirname,'../../dist');
    function digest(dir){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())digest(file);else if(name.endsWith('.js'))build.update(path.relative(dist,file).replace(/\\/g,'/')).update(fs.readFileSync(file));}}digest(dist);
    fs.writeFileSync(path.join(runtime,'api.pid'),String(process.pid));
    fs.writeFileSync(path.join(runtime,'api-environment.json'),JSON.stringify({host:require('node:os').hostname(),cpu:require('node:os').cpus()[0].model,logicalCores:require('node:os').cpus().length,node:process.version,buildSha256:build.digest('hex'),mode:'compiled / NODE_ENV=test',database:'PostgreSQL 17, private loopback port 55970'},null,2));
    const {Client}=require('pg'),originalQuery=Client.prototype.query,queries=new Map();
    Client.prototype.query=function(...args){
      const sql=typeof args[0]==='string'?args[0]:args[0]?.text,start=performance.now(),out=originalQuery.apply(this,args);
      if(out?.then&&sql)void out.then(()=>{
        const id=require('node:crypto').createHash('sha256').update(sql).digest('hex').slice(0,12),row=queries.get(id)??{id,statement:sql.replace(/\s+/g,' ').slice(0,100),count:0,totalMs:0,maxMs:0};
        const ms=performance.now()-start;row.count++;row.totalMs+=ms;row.maxMs=Math.max(row.maxMs,ms);queries.set(id,row);
      },()=>{});return out;
    };
    const {monitorEventLoopDelay}=require('node:perf_hooks');
    const delay=monitorEventLoopDelay({resolution:20});delay.enable();let cpu=process.cpuUsage(),time=process.hrtime.bigint();
    setInterval(()=>{const elapsed=Number(process.hrtime.bigint()-time)/1e6,next=process.cpuUsage();
      fs.appendFileSync(path.join(runtime,'api-metrics.ndjson'),JSON.stringify({at:new Date().toISOString(),rss:process.memoryUsage().rss,heap:process.memoryUsage().heapUsed,
        cpuPercent:((next.user-cpu.user)+(next.system-cpu.system))/1000/elapsed*100,eventLoopP95Ms:delay.percentile(95)/1e6,eventLoopMaxMs:delay.max/1e6})+'\n');
      delay.reset();cpu=next;time=process.hrtime.bigint();},5000).unref();
    setInterval(()=>fs.writeFileSync(path.join(runtime,'sql-profile.json'),JSON.stringify([...queries.values()].sort((a,b)=>b.totalMs-a.totalMs),null,2)),5000).unref();
    require('../../dist/index.js');
  }
  if(process.argv.includes('--frontend')){
    const frontend=path.resolve(__dirname,'../../../frontend');
    const child=require('node:child_process').spawn(process.execPath,[path.join(frontend,'node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port','51970','--strictPort'],{cwd:frontend,env:process.env,stdio:'inherit',windowsHide:true});
    child.on('exit',code=>{process.exitCode=code??1;});
  }
}
