/* Owned disposable PostgreSQL + real signed HTTP only. No production inputs. */
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
if(process.env.CERP_E2E_ISOLATED!=='1')throw Error('Explicit isolated fixture required');
process.env.NODE_ENV='test';require('ts-node/register/transpile-only');
const {Client,Pool}=require('pg'),express=require('express');
const root=path.resolve(__dirname,'../..'),port=Number(process.env.CERP_TABLET_PIN_FIXTURE_PORT),password=process.env.CERP_TABLET_PIN_FIXTURE_PASSWORD;
if(port!==28647||!password)throw Error('Owned common-access fixture boundary mismatch');
const id=crypto.randomUUID(),authority='cerp_directory_'+id.replace(/-/g,''),extra='cerp_test_'+crypto.randomBytes(16).toString('hex'),nonce=crypto.randomBytes(5).toString('hex');
const url=(db,user='cerp_fixture')=>{const u=new URL(`postgresql://127.0.0.1:${port}/${db}`);u.username=user;u.password=password;return u.toString();};
const checks=[],pools=[],servers=[];let directoryServer,defaultPool,sourceOnline=true;
const check=(name,ok)=>{if(!ok)throw Error('CHECK_FAILED:'+name);checks.push(name);};
const reject=async(name,work,status)=>{try{await work();check(name,false);}catch(e){if(e.message?.startsWith('CHECK_FAILED:'))throw e;check(name,e.status===status);}};
const listen=(app,port=0)=>new Promise((resolve,reject)=>{const server=app.listen(port,'127.0.0.1',()=>{servers.push(server);resolve(server.address().port);});server.once('error',reject);});
const pool=db=>{const value=new Pool({connectionString:url(db),max:4});pools.push(value);return value;};
const patch=async(db,file)=>db.query(await fs.readFile(path.join(root,file),'utf8'));
async function main(){
 const admin=pool('postgres');
 await admin.query("SELECT set_config('cerp.fixture_directory_password',$1,false)",[password]);
 await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_directory_app') THEN CREATE ROLE cerp_directory_app LOGIN; END IF; EXECUTE format('ALTER ROLE cerp_directory_app LOGIN PASSWORD %L',current_setting('cerp.fixture_directory_password')); END $$");
 for(const name of [authority,extra])await admin.query(`CREATE DATABASE "${name}" TEMPLATE cerp_common_access_template_1407`);
 if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='cerp_prod'")).rowCount)await admin.query('CREATE DATABASE cerp_prod TEMPLATE cerp_common_access_template_1407');
 const db=pool(authority),prod=pool('cerp_prod'),test=pool('cerp_test'),other=pool(extra);
 await patch(db,'db/patches/20261016_account_mfa_requirement_1372.sql');
 const {prepareOwnerBootstrap}=require('../../src/managed-tests/owner-bootstrap'),{installEmptyDirectory}=require('../../src/shared-directory/install');
 const ownerPassword='SyntheticA1+'+crypto.randomBytes(16).toString('hex');
 const seed=await prepareOwnerBootstrap({username:'OWNER'+nonce.toUpperCase(),name:'SYNTHETIC',surname:'OWNER',email:'owner.'+nonce+'@example.invalid',password:ownerPassword,weekly_hours:35,employment_type:'CDI',job_title:'Fixture'});
 // The installer deliberately requires a dedicated pg Client.
 const installer=new Client({connectionString:url(authority)});await installer.connect();
 try{await installEmptyDirectory(installer,id,seed);}finally{await installer.end();}
 for(const file of ['20261016_self_service_account_requests_1372.sql','20261019_tablet_pin_1372.sql','20261021_tablet_pin_only_1403.sql'])await patch(db,'db/shared-directory/patches/'+file);
 for(const siteDb of [prod,test,other])for(const file of ['20261016_account_mfa_requirement_1372.sql','20261014_shared_directory_sites_1568.sql','20261016_directory_password_assurance_1372.sql'])await patch(siteDb,'db/patches/'+file);
 const keys=new Map(['cerp_prod','cerp_test',extra].map(site=>[site,crypto.randomBytes(32).toString('hex')]));
 Object.assign(process.env,{DATABASE_URL:url(authority,'cerp_directory_app'),JWT_SECRET:crypto.randomBytes(48).toString('hex'),MFA_ROOT_KEY:crypto.randomBytes(32).toString('base64'),AUTH_RATE_LIMIT_HASH_KEY:crypto.randomBytes(48).toString('hex'),CERP_SHARED_DIRECTORY_ID:id});
 defaultPool=require('../../src/config/database').default;
 const {mountCommonAccessSource,synchronizeCommonAccess}=require('../../src/shared-directory/common-access');
 const source=express();source.use(express.json());mountCommonAccessSource(source,prod,{CERP_SHARED_DIRECTORY_ENABLED:'true',CERP_SHARED_DIRECTORY_SITE:'cerp_prod',CERP_SHARED_DIRECTORY_ID:id,CERP_DIRECTORY_SITE_CALL_KEY:keys.get('cerp_prod')});source.use((e,_req,res,_next)=>res.status(e.status||503).json({code:e.code||'FIXTURE_SOURCE_ERROR'}));
 const sourcePort=await listen(source),{createDirectoryServer}=require('../../src/shared-directory/server');
 const restricted=new Pool({connectionString:url(authority,'cerp_directory_app')});pools.push(restricted);
 directoryServer=createDirectoryServer({db:restricted,directoryId:id,sourceJwtSecret:process.env.JWT_SECRET,keys,commonAccessTransport:(address,options)=>{if(!sourceOnline)return Promise.reject(Error('Owned source paused'));if(String(address)!=='http://127.0.0.1:8080/internal/cerp/common-access-v1')throw Error('Unexpected source address');return fetch(`http://127.0.0.1:${sourcePort}/internal/cerp/common-access-v1`,options);}});
 await directoryServer.initialize();const directoryPort=await listen(directoryServer.app,8085);
 const {DirectoryClient}=require('../../src/shared-directory/client'),clients=new Map([...keys].map(([site,key])=>[site,new DirectoryClient(`http://127.0.0.1:${directoryPort}/internal/directory`,site,key)]));
 const a=clients.get('cerp_prod'),b=clients.get('cerp_test'),c=clients.get(extra),meta={ip:'127.0.0.1',user_agent:null,device_type:null,os:null,browser:null};
 const {totpForStep}=require('../../src/module/auth/domain/mfa'),mfa=new Map();
 async function authenticate(client,username,pw){
  const result=await client.call('login',{input:{username,password:pw},meta});
  if(result.directory_session)return result;
  check('MFA challenge uses existing factor or one first enrollment',result.status==='mfa_enrollment_required'||result.status==='mfa_required');
  let code;
  if(result.status==='mfa_enrollment_required'){check('no repeated factor enrollment',!mfa.has(username));code=totpForStep(result.totp.secret,Math.floor(Date.now()/30000));}
  else{check('same account has reusable MFA recovery',!!mfa.get(username)?.length);code=mfa.get(username).shift();}
  const verified=await client.call('verify-mfa',{input:{challenge_token:result.challenge_token,code},meta});
  if(verified.recovery_codes)mfa.set(username,[...verified.recovery_codes]);return verified;
 }
 const owner=await authenticate(a,seed.profile.username,ownerPassword);
 const requestedPassword='SyntheticB1+'+crypto.randomBytes(16).toString('hex');
 const {AVATAR_KEYS}=require('../../src/module/auth/validators/test-registration.validator');
 const submitted=await a.call('account-request-submit',{input:{name:'SYNTHETIC',surname:'ACCOUNT'+nonce.toUpperCase(),email:'account.'+nonce+'@example.invalid',password:requestedPassword,avatar_key:AVATAR_KEYS[0]}});
 const decision={id:submitted.request_id,key:crypto.randomUUID(),approval:{expected_version:0,primary_role:'Employee',roles:['Employee','Opérateur atelier'],administrative_kind:'BUSINESS_ADMIN',module_keys:['production','facturation']}};
 const prepared=await a.call('account-request-approve',{directory_session:owner.directory_session,input:decision});
 check('approval prepares exactly Prod and fixed Test inactive',(await db.query("SELECT count(*)::int AS n FROM cerp_directory_memberships WHERE profile_id=$1 AND status='Inactive' AND NOT is_superadmin",[prepared.profile_id])).rows[0].n===2);
 await reject('unactivated Test cannot authenticate',()=>b.call('login',{input:{username:prepared.username,password:requestedPassword},meta}),401);
 const runtime=require('../../src/shared-directory/site-runtime');
 async function initialize(siteDb,site){await runtime.initializeSharedDirectorySite(siteDb,{CERP_SHARED_DIRECTORY_ENABLED:'true',CERP_SHARED_DIRECTORY_SITE:site,CERP_SHARED_DIRECTORY_ID:id,CERP_DIRECTORY_ENDPOINT:`http://127.0.0.1:${directoryPort}/internal/directory`,CERP_DIRECTORY_SITE_CALL_KEY:keys.get(site)});}
 await initialize(prod,'cerp_prod');const projected=await runtime.projectDirectoryProfile(prod,prepared.profile);
 const {repoUpsertUserModuleAccess}=require('../../src/module/access-control/repository/access-control.repository'),{bumpRealtimeAuthorizationEpoch}=require('../../src/shared/realtime/realtime-control-plane');
 const tx=await prod.connect();try{await tx.query('BEGIN');for(const key of ['production','rh','facturation','administration'])await repoUpsertUserModuleAccess(tx,{userId:projected.id,moduleKey:key,access:['production','facturation'].includes(key)?'GRANTED':'DENIED',updatedBy:projected.id});await tx.query("INSERT INTO app_user_sensitive_capabilities(user_id,capability,granted,updated_by) VALUES($1,'audit.read',true,$1),($1,'finance.validate',true,$1)",[projected.id]);await bumpRealtimeAuthorizationEpoch(tx);await tx.query('COMMIT');}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
 await a.call('account-request-activate',{directory_session:owner.directory_session,input:{id:submitted.request_id,profile_id:prepared.profile_id,expected_version:prepared.version}});
 check('activation enables both fixed bases',(await db.query("SELECT count(*)::int AS n FROM cerp_directory_memberships WHERE profile_id=$1 AND status='Active' AND NOT is_superadmin",[prepared.profile_id])).rows[0].n===2);
 const productionLogin=await authenticate(a,prepared.username,requestedPassword),testLogin=await authenticate(b,prepared.username,requestedPassword),extraLogin=await authenticate(c,prepared.username,requestedPassword);
 check('same immutable account and MFA factor across all bases',[testLogin,extraLogin].every(v=>v.identity.profile_id===productionLogin.identity.profile_id&&v.identity.mfa_factor_id===productionLogin.identity.mfa_factor_id&&!v.identity.is_superadmin));
 for(const [siteDb,site,client,login] of [[test,'cerp_test',b,testLogin],[other,extra,c,extraLogin]]){await initialize(siteDb,site);await runtime.projectDirectoryIdentity(siteDb,login.identity);await synchronizeCommonAccess(siteDb,client,site,prepared.profile_id);const grants=(await siteDb.query('SELECT a.module_key,a.access FROM app_module_user_access a JOIN users u ON u.id=a.user_id WHERE u.directory_profile_id=$1',[prepared.profile_id])).rows;check('closed Production module selection projected '+site,grants.filter(v=>v.access==='GRANTED').map(v=>v.module_key).sort().join(',')==='facturation,production');check('sensitive grants projected '+site,(await siteDb.query('SELECT count(*)::int AS n FROM app_user_sensitive_capabilities a JOIN users u ON u.id=a.user_id WHERE u.directory_profile_id=$1 AND granted',[prepared.profile_id])).rows[0].n===2);}
 const signatureBefore=(await db.query('SELECT password FROM users WHERE id=$1',[productionLogin.identity.source_user_id])).rows[0].password;
 await a.call('tablet-pin-set',{directory_session:productionLogin.directory_session,input:{pin:'1407'},meta});
 const device=await a.call('tablet-pin-admin-create-device',{directory_session:owner.directory_session,input:{name:'Shared synthetic installation'},meta}),paired=await a.call('tablet-pin-pair',{input:{pairing_code:device.pairingCode},meta});
 for(const client of [a,b,c]){const pin=await client.call('tablet-pin-login',{input:{pin:'1407',device_id:paired.deviceId,device_secret:paired.deviceSecret},meta});check('PIN still requires shared MFA',pin.status==='mfa_required');const otherClient=client===a?b:a;await reject('PIN MFA challenge is target-bound',()=>otherClient.call('verify-mfa',{input:{challenge_token:pin.challenge_token,code:mfa.get(prepared.username)[0]},meta}),401);const verified=await client.call('verify-mfa',{input:{challenge_token:pin.challenge_token,code:mfa.get(prepared.username).shift()},meta});check('same PIN and paired device on registered target',verified.identity.profile_id===prepared.profile_id&&verified.identity.mfa_factor_id===productionLogin.identity.mfa_factor_id);}
 check('password and single factor preserved',signatureBefore===(await db.query('SELECT password FROM users WHERE id=$1',[productionLogin.identity.source_user_id])).rows[0].password&&(await db.query("SELECT count(*)::int AS n FROM user_mfa_factors WHERE user_id=$1 AND state='ACTIVE'",[productionLogin.identity.source_user_id])).rows[0].n===1);
 const revoke=await prod.connect();try{await revoke.query('BEGIN');await repoUpsertUserModuleAccess(revoke,{userId:projected.id,moduleKey:'facturation',access:'DENIED',updatedBy:projected.id});await revoke.query('UPDATE app_user_sensitive_capabilities SET granted=false,version=version+1 WHERE user_id=$1',[projected.id]);await bumpRealtimeAuthorizationEpoch(revoke);await revoke.query('COMMIT');}finally{revoke.release();}
 await b.validate(testLogin.directory_session);await synchronizeCommonAccess(test,b,'cerp_test',prepared.profile_id);
 check('live Production revocation applies with existing Test session',(await test.query("SELECT count(*)::int AS n FROM app_module_user_access a JOIN users u ON u.id=a.user_id WHERE u.directory_profile_id=$1 AND a.module_key='facturation' AND access='GRANTED'",[prepared.profile_id])).rows[0].n===0&&(await test.query('SELECT count(*)::int AS n FROM app_user_sensitive_capabilities a JOIN users u ON u.id=a.user_id WHERE u.directory_profile_id=$1 AND granted',[prepared.profile_id])).rows[0].n===0);
 const epochBefore=(await test.query('SELECT epoch::text FROM realtime_authorization_epoch WHERE singleton')).rows[0].epoch;await synchronizeCommonAccess(test,b,'cerp_test',prepared.profile_id);check('same source policy is idempotent',epochBefore===(await test.query('SELECT epoch::text FROM realtime_authorization_epoch WHERE singleton')).rows[0].epoch);
 sourceOnline=false;await reject('source unavailable is retryable 503',()=>synchronizeCommonAccess(test,b,'cerp_test',prepared.profile_id),503);sourceOnline=true;check('source outage does not delete Directory session',!!(await b.validate(testLogin.directory_session)));
 await db.query("UPDATE cerp_directory_memberships SET status='Blocked',version=version+1 WHERE profile_id=$1 AND database_id='cerp_test'",[prepared.profile_id]);await reject('explicit Test block is preserved on password login',()=>b.call('login',{input:{username:prepared.username,password:requestedPassword},meta}),401);await reject('explicit Test block invalidates existing session',()=>b.validate(testLogin.directory_session),401);
 const unknown='cerp_test_'+crypto.randomBytes(16).toString('hex'),unknownClient=new DirectoryClient(`http://127.0.0.1:${directoryPort}/internal/directory`,unknown,crypto.randomBytes(32).toString('hex'));await reject('unknown site cannot reuse account',()=>unknownClient.call('login',{input:{username:prepared.username,password:requestedPassword},meta}),401);check('unknown site creates no membership',!(await db.query('SELECT 1 FROM cerp_directory_memberships WHERE database_id=$1',[unknown])).rowCount);
 await db.query("UPDATE cerp_directory_memberships SET status='Inactive',version=version+1 WHERE profile_id=$1 AND database_id='cerp_prod'",[prepared.profile_id]);await reject('Production deactivation invalidates managed Test session',()=>c.validate(extraLogin.directory_session),401);
 console.log(JSON.stringify({result:'passed',checks:checks.length,scenarios:checks,secrets_emitted:false,business_data:'synthetic-only',isolation:'OWNED_LOOPBACK_28647'}));
}
main().catch(e=>{console.error(JSON.stringify({result:'failed',code:e.code||e.name,message:String(e.message).slice(0,200),stage:checks.at(-1),checks:checks.length,frames:e.stack?.split('\n').slice(1,4)}));process.exitCode=1;}).finally(async()=>{directoryServer?.close();for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await Promise.allSettled(pools.map(db=>db.end()));if(defaultPool)await defaultPool.end();});
