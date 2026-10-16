// Owned loopback qualification only. Private seed/password never enter Git/logs.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
process.env.NODE_ENV='test';require('ts-node/register/transpile-only');
const {Client}=require('pg'),request=require('supertest');
const {installEmptyDirectory}=require('../../src/shared-directory/install');
const runtime=path.resolve(__dirname,'../../../cerp-onboarding-1563-runtime'),seedFile=path.join(runtime,'private-identity-1568','owner-bootstrap.json');
const directoryId=crypto.randomUUID(),database=`cerp_directory_${directoryId.replace(/-/g,'')}`,checks=[];
const admin='postgresql://cerp_fixture@127.0.0.1:15463/postgres';let pool;
function check(name,ok){if(!ok)throw new Error(`CHECK_FAILED:${name}`);checks.push(name);}
async function password(){if(process.stdin.isTTY)process.stdin.setRawMode(true);return new Promise((resolve,reject)=>{let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',p=>{raw+=p;if(Buffer.byteLength(raw)>512){process.stdin.destroy();reject(new Error('PRIVATE_PASSWORD_INPUT_INVALID'));}else if(/[\r\n]/.test(raw)){process.stdin.destroy();resolve(raw.trim());}});process.stdin.on('end',()=>reject(new Error('PRIVATE_PASSWORD_INPUT_REQUIRED')));});}
async function main(){
 const secret=await password(),seed=JSON.parse(await fs.readFile(seedFile,'utf8'));
 const candidates=await Promise.all((await fs.readdir(runtime)).filter(n=>/^managed-[a-f0-9]{10}$/.test(n)).map(async n=>({n,at:(await fs.stat(path.join(runtime,n))).mtimeMs})));
 candidates.sort((a,b)=>b.at-a.at);const nonce=candidates[0]?.n.slice(8);if(!nonce)throw new Error('OWNED_TEMPLATE_REQUIRED');
 const client=new Client({connectionString:admin});await client.connect();
 try{
  const identity=(await client.query('SELECT current_user actor,inet_server_port() port')).rows[0];check('owned fixture cluster',identity.actor==='cerp_fixture'&&identity.port===15463);
  await client.query(`CREATE DATABASE "${database}" TEMPLATE "cerp_test_template_fixture_${nonce}"`);
  await client.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_directory_app') THEN CREATE ROLE cerp_directory_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$");
 }finally{await client.end();}
 const db=new Client({connectionString:`postgresql://cerp_fixture@127.0.0.1:15463/${database}`});await db.connect();
 try{
  check('starts without any imported users or company',(await db.query('SELECT (SELECT count(*) FROM users)+(SELECT count(*) FROM factureur) n')).rows[0].n==='0');
  await db.query(await fs.readFile(path.join(__dirname,'../../db/patches/20261016_account_mfa_requirement_1372.sql'),'utf8'));
  const installed=await installEmptyDirectory(db,directoryId,seed);await db.query(await fs.readFile(path.join(__dirname,'../../db/shared-directory/patches/20261016_self_service_account_requests_1372.sql'),'utf8'));check('private owner installed once',!installed.replayed);
  check('new directory defaults MFA policy to optional',(await db.query("SELECT value_text FROM public.erp_settings WHERE key='security.mfa_policy'")).rows[0]?.value_text==='optional');
  await db.query("UPDATE public.erp_settings SET value_text='required_for_all' WHERE key='security.mfa_policy'");
  check('same owner command replays without duplicate',(await installEmptyDirectory(db,directoryId,seed)).replayed);
  check('directory replay preserves the configured MFA policy',(await db.query("SELECT value_text FROM public.erp_settings WHERE key='security.mfa_policy'")).rows[0]?.value_text==='required_for_all');
  const profile=(await db.query('SELECT p.weekly_hours_target,p.employment_type,p.job_title,u.avatar_key,u.mfa_reenrollment_required FROM cerp_directory_profiles p JOIN users u ON u.id=p.user_id')).rows[0];
  check('39h CDI and requested job, without invented avatar',Number(profile.weekly_hours_target)===39&&profile.employment_type==='CDI'&&profile.job_title===seed.profile.job_title&&profile.avatar_key===null&&profile.mfa_reenrollment_required===true);
  check('only requested owner has active Prod and common Test administration',(await db.query("SELECT count(*) n FROM cerp_directory_memberships WHERE database_id IN ('cerp_prod','cerp_test') AND is_superadmin AND status='Active'")).rows[0].n==='2');
  check('company remains unconfigured',(await db.query('SELECT count(*) n FROM factureur')).rows[0].n==='0');
 }finally{await db.end();}
 process.env.DATABASE_URL=`postgresql://cerp_fixture@127.0.0.1:15463/${database}`;process.env.JWT_SECRET=crypto.randomBytes(48).toString('hex');process.env.MFA_ROOT_KEY=crypto.randomBytes(32).toString('base64');process.env.AUTH_RATE_LIMIT_HASH_KEY=crypto.randomBytes(48).toString('hex');
 pool=require('../../src/config/database').default;
 const {createDirectoryServer}=require('../../src/shared-directory/server'),{signDirectoryCall}=require('../../src/shared-directory/call-signature');
 const key=crypto.randomBytes(32).toString('hex'),server=createDirectoryServer({db:pool,directoryId,sourceJwtSecret:process.env.JWT_SECRET,keys:new Map([['cerp_test',key]])});await server.initialize();
 const body=Buffer.from(JSON.stringify({input:{username:seed.profile.username,password:secret},meta:{ip:null,user_agent:null,device_type:null,os:null,browser:null}})),url='/internal/directory/login',headers=signDirectoryCall('cerp_test',key,'POST',url,body);
 const login=await request(server.app).post(url).set(headers).set('Content-Type','application/json').send(body.toString());
 check('first login requires actual MFA enrollment before any session',login.status===200&&login.body.status==='mfa_enrollment_required'&&!!login.body.totp?.qr_data_url&&!login.body.directory_session&&!login.body.token);
 const replay=await request(server.app).post(url).set(headers).set('Content-Type','application/json').send(body.toString());check('signed call replay refused',replay.status===401);
 return {result:'PASS',checks,first_login_mfa_required:true,local_only:true,live_prod_changed:false,live_test_changed:false,owner_installed_online:false};
}
main().then(async report=>{await fs.writeFile(path.join(__dirname,'../../docs/testing/evidence/shared-directory-owner-1568.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({result:report.result,checks:checks.length,owner_installed_online:false}));}).catch(()=>{console.error(JSON.stringify({result:'FAIL',checks:checks.length,owner_installed_online:false}));process.exitCode=1;}).finally(async()=>{if(pool)await pool.end();});
