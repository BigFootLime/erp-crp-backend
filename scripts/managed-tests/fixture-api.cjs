// Disposable API child with a fixed real PostgreSQL pool. No business runtime entry.
require('ts-node/register/transpile-only');
const fs=require('node:fs'),path=require('node:path'),express=require('express');
const pool=require('../../src/config/database').default;
const {connectedTestInfo,assertManagedDatabaseAtStartup}=require('../../src/config/managed-database');
async function main(){
 await assertManagedDatabaseAtStartup(pool);
 for(const key of ['CERP_STORAGE_ROOT','CERP_TMP_ROOT','CERP_IMAGES_ROOT'])fs.mkdirSync(process.env[key],{recursive:true});
 require('../../src/shared/uploads/upload-scanner').setUploadScannerForTests({name:'managed-fixture',scan:async()=>({status:'clean',provider:'managed-fixture'})});
 const app=express();app.use(express.json());
 app.get('/api/v1/environment',async(_req,res)=>{const info=await connectedTestInfo(pool);res.json({database:info?.database,environment:info ? 'test':'unknown',label:info?.label});});
 app.use('/api/v1/auth',require('../../src/module/auth/routes/auth.routes').default);
 app.use('/api/v1/admin/onboarding',require('../../src/module/onboarding/routes/onboarding.routes').default);
 app.use((error,_req,res,_next)=>res.status(error.status??(error.name==='ZodError'?400:500)).json({code:error.code??error.name,diagnostic:error.message?.replace(/postgres(?:ql)?:\/\/\S+/g,'[fixture connection]')}));
 const server=app.listen(Number(process.env.PORT),'127.0.0.1',()=>process.send?.({ready:true,port:server.address().port}));
 process.once('SIGTERM',()=>server.close(()=>{void pool.end().finally(()=>process.exit(0));}));
}
main().catch(async error=>{process.send?.({ready:false,code:error.code??(/^MANAGED_[A-Z_]+$/.test(error.message)?error.message:error.name),diagnostic:error.message?.replace(/postgres(?:ql)?:\/\/\S+/g,'[fixture connection]')});process.exitCode=1;await pool.end();process.disconnect?.();});
