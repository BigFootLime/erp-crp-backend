const {Client}=require('pg');
async function connectIsolated(){
  const url=new URL(process.env.DATABASE_URL??'http://invalid');
  if(url.hostname!=='127.0.0.1'||url.port!=='55970'||url.pathname!=='/cerp_test')throw new Error('Dedicated performance database required');
  const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
  const state=(await db.query("SELECT current_database() AS db,current_setting('data_directory') AS directory")).rows[0];
  if(state.db!=='cerp_test'||state.directory!=='/tmp/cerp-planning-perf-970/pg'){await db.end();throw new Error('Unexpected data directory');}
  return db;
}
module.exports={connectIsolated};
if(require.main===module)(async()=>{
  const db=await connectIsolated();
  try{
    await db.query("INSERT INTO public.planning_central_settings(singleton,activation) VALUES(true,'COMMIT') ON CONFLICT DO NOTHING");
    await db.query('INSERT INTO public.planning_forecast_state(singleton) VALUES(true) ON CONFLICT DO NOTHING');
    await db.query('INSERT INTO public.planning_learning_state(singleton) VALUES(true) ON CONFLICT DO NOTHING');
    const fs=require('node:fs'),path=require('node:path');
    const roleSeed=fs.readFileSync(path.join(__dirname,'../../db/patches/20260727_user_multi_roles_315.sql'),'utf8').match(/INSERT INTO public\.app_roles[\s\S]*?;/)[0];
    await db.query(roleSeed);
    const moduleSeed=fs.readFileSync(path.join(__dirname,'../../db/patches/20260727_admin_access_tower_326.sql'),'utf8').match(/INSERT INTO public\.app_modules[\s\S]*?ON CONFLICT[\s\S]*?;/)[0];
    await db.query(moduleSeed);
    console.log('Dedicated planning settings initialized');
  }finally{await db.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
