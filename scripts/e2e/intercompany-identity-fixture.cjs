#!/usr/bin/env node
/* Disposable two-company Directory authority qualification (#1454). */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
process.env.NODE_ENV = 'test';
require('ts-node/register/transpile-only');
const { installEmptyDirectory } = require('../../src/shared-directory/install');
const { DirectoryClient } = require('../../src/shared-directory/client');
const { prepareOwnerBootstrap } = require('../../src/managed-tests/owner-bootstrap');

const root = path.resolve(__dirname, '../..');
const nonce = crypto.randomBytes(16).toString('hex');
let directoryId = crypto.randomUUID();
let directoryDb = `cerp_directory_${directoryId.replace(/-/g, '')}`;
let buyerSite = `cerp_company_${crypto.randomBytes(16).toString('hex')}_test`;
let sellerSite = `cerp_company_${crypto.randomBytes(16).toString('hex')}_test`;
const fixtureUrl = new URL(process.env.DATABASE_URL || '');
if (!['127.0.0.1', 'localhost', '::1'].includes(fixtureUrl.hostname) || fixtureUrl.port !== '15464' || !/^\/cerp_ec1454_seller(?:_v2)?$/.test(fixtureUrl.pathname)) throw new Error(`INTERCOMPANY_FIXTURE_DATABASE_REQUIRED:${fixtureUrl.hostname}:${fixtureUrl.port}${fixtureUrl.pathname}`);
const runtime = path.resolve(root, '..', '..', '.codex-tmp', 'intercompany-e2e-1454', `identity-${nonce}`);
const adminUrl = new URL(fixtureUrl); adminUrl.pathname = '/postgres';
const dbUrl = (database, role) => { const u = new URL(fixtureUrl); u.pathname = `/${database}`; if (role) u.username = role; return u.toString(); };
const checks = []; let child; let directoryPassword;
const check = (name, value) => { if (!value) throw new Error(`CHECK_FAILED:${name}`); checks.push(name); };
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const q = (...p) => fs.readFile(path.join(root, ...p), 'utf8');

async function client(database, role) { const c = new Client({ connectionString: dbUrl(database, role) }); await c.connect(); return c; }
async function clearClone(db) {
  const allowed = new Set(['app_roles','app_modules','cerp_schema_migrations','currencies','units','production_machine_families','planning_central_settings','realtime_authorization_epoch','realtime_event_sequence_state','realtime_control_plane_v2_provenance','cerp_test_template_meta']);
  const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r => r.tablename).filter(name => !allowed.has(name));
  if (tables.length) {
    await db.query("SET session_replication_role='replica'");
    try { await db.query(`TRUNCATE TABLE ${tables.map(name => `public."${name.replaceAll('"','""')}"`).join(',')} RESTART IDENTITY CASCADE`); }
    finally { await db.query("SET session_replication_role='origin'"); }
  }
  await db.query("INSERT INTO public.planning_central_settings(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING");
}
async function waitFor(client) { for (let i=0;i<80;i+=1) { try { await client.call('info',{}); return; } catch { await pause(125); } } throw new Error('DIRECTORY_START_TIMEOUT'); }
async function expectDenied(client, operation) { try { await client.call(operation,{input:{}}); } catch (error) { return error && error.status === 403; } return false; }
async function main() {
  await fs.mkdir(runtime,{recursive:true,mode:0o700});
  const admin = new Client({connectionString:adminUrl.toString()}); await admin.connect();
  try {
    const identity=(await admin.query('SELECT current_database() db,current_user actor,inet_server_addr()::text host,inet_server_port() port')).rows[0];
    check('owned loopback PostgreSQL fixture', identity.db==='postgres' && identity.port===5432);
    if (process.argv.includes('--reuse-incomplete')) {
      const candidates=(await admin.query("SELECT datname FROM pg_database WHERE datname ~ '^cerp_directory_[a-f0-9]{32}$' ORDER BY datname DESC")).rows.map(row=>row.datname);
      let candidateStates=[], reused=false;
      for (const candidate of candidates) {
        const probe=await client(candidate);
        try {
          const state=(await probe.query("SELECT to_regclass('public.cerp_shared_directory') IS NULL AS uninstalled,(SELECT count(*)::int FROM public.users) AS users,(SELECT count(*)::int FROM public.users WHERE username='IDENTITY_FIXTURE_OWNER') AS fixture_owner")).rows[0];
          candidateStates.push({candidate,uninstalled:state.uninstalled,users:state.users,fixture_owner:state.fixture_owner});
          if ((state.uninstalled && state.users===0) || state.fixture_owner===1 || (!state.uninstalled && state.users===0)) { directoryDb=candidate; reused=true; const id=candidate.slice('cerp_directory_'.length); directoryId=`${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`; buyerSite=`cerp_company_${id}_test`; sellerSite=`cerp_company_${id.split('').reverse().join('')}_test`; break; }
        } finally { await probe.end(); }
      }
      if (!reused) throw new Error(`INCOMPLETE_DIRECTORY_CLONE_NOT_FOUND:${JSON.stringify(candidateStates)}`);
    }
    const existing=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[directoryDb])).rowCount; check('fresh disposable Directory name', process.argv.includes('--reuse-incomplete') ? existing===1 : existing===0);
    await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_directory_app') THEN CREATE ROLE cerp_directory_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; ELSE ALTER ROLE cerp_directory_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$");
    directoryPassword=crypto.randomBytes(32).toString('base64url');
    await admin.query(`ALTER ROLE cerp_directory_app PASSWORD '${directoryPassword}'`);
    if (!process.argv.includes('--reuse-incomplete')) await admin.query(`CREATE DATABASE "${directoryDb}" TEMPLATE "cerp_ec1454_seller"`);
  } finally { await admin.end(); }
  const authority = await client(directoryDb);
  try {
    await clearClone(authority);
    const identity=(await authority.query('SELECT current_database() db,current_user actor')).rows[0]; check('Directory clone identity',identity.db===directoryDb && identity.actor===decodeURIComponent(fixtureUrl.username));
    const seed=await prepareOwnerBootstrap({username:'IDENTITY_FIXTURE_OWNER',name:'IDENTITY',surname:'FIXTURE',email:`identity.${nonce}@example.invalid`,password:`FixtureA1+${nonce}`,weekly_hours:39,employment_type:'CDI',job_title:'Fixture owner'});
    const installed=(await authority.query("SELECT to_regclass('public.cerp_shared_directory') IS NOT NULL AS yes")).rows[0].yes;
    const users=(await authority.query('SELECT count(*)::int AS n FROM public.users')).rows[0].n;
    if (installed && users===0) await authority.query('DROP TABLE IF EXISTS public.cerp_business_company_switches,public.cerp_business_company_instances,public.cerp_business_company_memberships,public.cerp_business_companies,public.cerp_directory_call_nonces,public.cerp_directory_challenges,public.cerp_directory_sessions,public.cerp_directory_bootstrap_commands,public.cerp_directory_memberships,public.cerp_directory_profiles,public.cerp_shared_directory CASCADE');
    const ready=(await authority.query("SELECT to_regclass('public.cerp_shared_directory') IS NOT NULL AS yes")).rows[0].yes;
    if (!ready) await installEmptyDirectory(authority,directoryId,seed);
    await authority.query(await q('db','shared-directory','20261026_business_companies_1454.sql'));
    if ((await authority.query("SELECT to_regclass('public.cerp_directory_account_requests') IS NULL AS missing")).rows[0].missing) {
      await authority.query(await q('db','shared-directory','patches','20261016_self_service_account_requests_1372.sql'));
    }
    const owner=(await authority.query("SELECT p.profile_id::text,u.id FROM public.cerp_directory_profiles p JOIN public.users u ON u.id=p.user_id WHERE u.username='IDENTITY_FIXTURE_OWNER'")).rows[0];
    const profileId=owner.profile_id, userId=owner.id;
    const buyerCompany='11111111-1111-4111-8111-111111111111', sellerCompany='22222222-2222-4222-8222-222222222222';
    const existingSites=(await authority.query("SELECT company_id::text,site_id FROM public.cerp_business_company_instances WHERE company_id IN ($1::uuid,$2::uuid)",[buyerCompany,sellerCompany])).rows;
    buyerSite=existingSites.find(row=>row.company_id===buyerCompany)?.site_id ?? buyerSite;
    sellerSite=existingSites.find(row=>row.company_id===sellerCompany)?.site_id ?? sellerSite;
    await authority.query(`INSERT INTO public.cerp_business_companies(company_id,code,name,profile,status,enabled_module_keys,enabled_commercial_projection_capabilities,created_by_user_id,updated_by_user_id) VALUES
      ($1::uuid,'BUYER-TEST','Buyer Fixture','COMMERCIAL','ACTIVE',ARRAY['clients','devis','commandes-clients'],ARRAY['stock.projection.read'],$3,$3),
      ($2::uuid,'SELLER-TEST','Seller Fixture','INDUSTRIAL','ACTIVE',ARRAY['commandes-clients','production'],ARRAY[]::text[],$3,$3)
      ON CONFLICT(company_id) DO NOTHING`,[buyerCompany,sellerCompany,userId]);
    await authority.query(`INSERT INTO public.cerp_business_company_memberships(company_id,profile_id,status,allowed_module_keys,denied_module_keys,enabled_commercial_projection_capabilities,created_by_user_id,updated_by_user_id) VALUES
      ($1::uuid,$3::uuid,'ACTIVE',ARRAY['clients','devis','commandes-clients'],ARRAY[]::text[],ARRAY['stock.projection.read'],$4,$4),
      ($2::uuid,$3::uuid,'ACTIVE',ARRAY['commandes-clients'],ARRAY[]::text[],ARRAY[]::text[],$4,$4) ON CONFLICT(company_id,profile_id) DO NOTHING`,[buyerCompany,sellerCompany,profileId,userId]);
    await authority.query(`INSERT INTO public.cerp_business_company_instances(company_id,environment,site_id,active,created_by_user_id,updated_by_user_id) VALUES($1::uuid,'cerp_test',$2,true,$3,$3),($4::uuid,'cerp_test',$5,true,$3,$3) ON CONFLICT(company_id,environment) DO NOTHING`,[buyerCompany,buyerSite,userId,sellerCompany,sellerSite]);
    await authority.query(`INSERT INTO public.cerp_directory_memberships(profile_id,database_id,role_key,status,is_superadmin,version) VALUES($1::uuid,$2,'Administrateur Systeme et Reseau','Active',false,1),($1::uuid,$3,'Administrateur Systeme et Reseau','Active',false,1) ON CONFLICT(profile_id,database_id) DO NOTHING`,[profileId,buyerSite,sellerSite]);
    check('seeded two registered TEST company sites',true);
  } finally { await authority.end(); }
  const callerFile=path.join(runtime,'callers.json'), port=8085;
  const buyerKey=crypto.randomBytes(32).toString('hex'),sellerKey=crypto.randomBytes(32).toString('hex'),unknownKey=crypto.randomBytes(32).toString('hex');
  await fs.writeFile(callerFile,JSON.stringify([{site:buyerSite,key:buyerKey},{site:sellerSite,key:sellerKey},{site:`cerp_company_${crypto.randomBytes(16).toString('hex')}_test`,key:unknownKey}]),{mode:0o600});
  const serviceConnection=new URL(dbUrl(directoryDb,'cerp_directory_app')); serviceConnection.password=directoryPassword;
  const serviceEnv={...process.env,NODE_ENV:'test',CERP_INTERCOMPANY_IDENTITY_FIXTURE:'1',DATABASE_URL:serviceConnection.toString(),JWT_SECRET:crypto.randomBytes(48).toString('hex'),AUTH_RATE_LIMIT_HASH_KEY:crypto.randomBytes(48).toString('hex'),CERP_SHARED_DIRECTORY_ID:directoryId,CERP_DIRECTORY_CALLERS_FILE:callerFile,CERP_INTERCOMPANY_DIRECTORY_PORT:String(port),CERP_BUSINESS_COMPANIES_ENABLED:'true'};
  child=spawn(process.execPath,['scripts/e2e/intercompany-identity-authority.cjs'],{cwd:root,env:serviceEnv,stdio:['ignore','ignore','pipe']}); let stderr=''; child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000); void fs.writeFile(path.join(runtime,'authority.stderr.log'),stderr,{mode:0o600});});
  const base=`http://127.0.0.1:${port}/internal/directory`, buyer=new DirectoryClient(base,buyerSite,buyerKey), seller=new DirectoryClient(base,sellerSite,sellerKey);
  await waitFor(buyer); check('real Directory authority reachable',true);
  const buyerInstance=await buyer.call('business-company-instance',{input:{}}), buyerContext=await buyer.call('business-company-sign-in-context',{input:{}}), sellerInstance=await seller.call('business-company-instance',{input:{}}), sellerContext=await seller.call('business-company-sign-in-context',{input:{}});
  check('buyer instance/environment receipt',buyerInstance.company_id==='11111111-1111-4111-8111-111111111111'&&buyerInstance.environment==='cerp_test'&&buyerContext.company.code==='BUYER-TEST'&&buyerContext.environment==='cerp_test');
  check('seller instance/environment receipt',sellerInstance.company_id==='22222222-2222-4222-8222-222222222222'&&sellerInstance.environment==='cerp_test'&&sellerContext.company.code==='SELLER-TEST'&&sellerContext.environment==='cerp_test');
  const unknownSite=JSON.parse(await fs.readFile(callerFile,'utf8'))[2].site; const unknown=new DirectoryClient(base,unknownSite,unknownKey);
  check('unknown registered-key but unconfigured site is denied',await expectDenied(unknown,'business-company-instance'));
  const teardown={pid:child.pid,port,directory_database:directoryDb,marker:nonce,owner:'cerp-task=1454',runtime}; await fs.writeFile(path.join(runtime,'teardown.json'),JSON.stringify(teardown,null,2),{mode:0o600});
  console.log(JSON.stringify({result:'INTERCOMPANY_IDENTITY_FIXTURE_OK',checks,receipts:{buyer:buyerContext,seller:sellerContext},teardown:{pid:child.pid,port,directory_database:directoryDb,runtime}}));
}
main().catch(async error=>{await fs.writeFile(path.join(runtime,'result.json'),JSON.stringify({result:'FAILED',error:error instanceof Error?error.message:String(error)},{},2),{mode:0o600});console.error(error instanceof Error?error.stack:error);process.exitCode=1;}).finally(()=>{ if(process.exitCode){if(child&&!child.killed)child.kill('SIGTERM');} });
