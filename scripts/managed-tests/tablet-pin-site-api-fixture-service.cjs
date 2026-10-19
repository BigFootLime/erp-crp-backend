/* Disposable site API used only by check-tablet-pin-http-1372.cjs. */
process.env.NODE_ENV='test';
require('ts-node/register/transpile-only');

const express=require('express');
const pool=require('../../src/config/database').default;
const siteRuntime=require('../../src/shared-directory/site-runtime');
const {DirectoryClient}=require('../../src/shared-directory/client');
const {errorHandler}=require('../../src/middlewares/errorHandler');

const fixtureError=(stage,error,operation)=>console.error(JSON.stringify({type:'tablet_pin_site_fixture_error',stage,operation:operation??null,name:error?.name??null,code:error?.code??null,status:error?.status??null,constraint:error?.constraint??null,stack:typeof error?.stack==='string'?error.stack.split('\n').slice(0,8):null}));
const directoryCall=DirectoryClient.prototype.call;
DirectoryClient.prototype.call=async function(operation,payload){try{return await directoryCall.call(this,operation,payload)}catch(error){fixtureError('directory_call',error,operation);throw error;}};
const directoryAuthenticationResult=siteRuntime.directoryAuthenticationResult;
siteRuntime.directoryAuthenticationResult=async(...args)=>{try{return await directoryAuthenticationResult(...args)}catch(error){fixtureError('directory_authentication_result',error);throw error;}};
const v1Router=require('../../src/routes/v1.routes').default;

async function main(){
 await siteRuntime.initializeSharedDirectorySite(pool);
 const app=express();
 const fixtureNonce=process.env.CERP_TABLET_PIN_SITE_FIXTURE_NONCE;
 if(!fixtureNonce)throw new Error('CERP_TABLET_PIN_SITE_FIXTURE_NONCE is required');
 app.get('/__tablet-pin-fixture-health',(_req,res)=>res.json({fixtureNonce,pid:process.pid}));
 app.use(express.json({limit:'1mb'}));
 app.use('/api/v1',v1Router);
 app.use(errorHandler);
 const server=app.listen(Number(process.env.PORT||8086),'127.0.0.1');
 const close=()=>server.close(()=>void pool.end().finally(()=>process.exit(0)));
 process.once('SIGTERM',close);process.once('SIGINT',close);
}
main().catch(error=>{console.error(error.stack||error);void pool.end().finally(()=>process.exit(1));});
