const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
process.env.NODE_ENV='test';require('ts-node/register/transpile-only');
const {Client}=require('pg'),{prepareDirectoryOwnerFixture}=require('./directory-owner-fixture.cjs');
const {prepareOwnerBootstrap}=require('../../src/managed-tests/owner-bootstrap'),{installEmptyDirectory}=require('../../src/shared-directory/install'),{assertDirectoryApplicationRole}=require('../../src/shared-directory/session.repository');
const runtime=path.resolve(__dirname,'../../../cerp-onboarding-1563-runtime'),id=crypto.randomUUID(),database=`cerp_directory_${id.replace(/-/g,'')}`;
async function main(){
 const candidates=await Promise.all((await fs.readdir(runtime)).filter(n=>/^managed-[a-f0-9]{10}$/.test(n)).map(async n=>({n,at:(await fs.stat(path.join(runtime,n))).mtimeMs})));candidates.sort((a,b)=>b.at-a.at);
 const admin=new Client({connectionString:'postgresql://cerp_fixture@127.0.0.1:15463/postgres'});await admin.connect();
 try{const own=(await admin.query('SELECT current_user actor,inet_server_port() port')).rows[0];if(own.actor!=='cerp_fixture'||own.port!==15463)throw Error('OWNED_FIXTURE_REQUIRED');await admin.query(`CREATE DATABASE "${database}" TEMPLATE "cerp_test_template_fixture_${candidates[0].n.slice(8)}"`);}finally{await admin.end();}
 const db=new Client({connectionString:`postgresql://cerp_fixture@127.0.0.1:15463/${database}`});await db.connect();
 try{
  await prepareDirectoryOwnerFixture(db);let originalFailure=false;
  await db.query('BEGIN');
  try{
   await db.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM cerp_app; REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM cerp_app');
   const user=(await db.query("INSERT INTO users(username,password,name,surname,email,role,status) VALUES('ACL_FIXTURE','unusable','FIXTURE','OWNER','acl@example.invalid','Administrateur Systeme et Reseau','Active') RETURNING id")).rows[0];
   await db.query("INSERT INTO user_role_assignments(user_id,role_key) VALUES($1,'Administrateur Systeme et Reseau')",[user.id]);
  }catch(error){originalFailure=error.code==='42501'&&error.message==='permission denied for table app_roles';}finally{await db.query('ROLLBACK');}
  if(!originalFailure)throw Error('ORIGINAL_ACL_FAILURE_NOT_REPRODUCED');
  const seed=await prepareOwnerBootstrap({username:'ACL_FIXTURE',name:'FIXTURE',surname:'OWNER',email:'acl@example.invalid',password:`SyntheticA1+${crypto.randomBytes(16).toString('hex')}`,weekly_hours:39,employment_type:'CDI',job_title:'Synthetic ACL qualification'});
  await db.query(await fs.readFile(path.join(__dirname,'../../db/patches/20261016_account_mfa_requirement_1372.sql'),'utf8'));
  await installEmptyDirectory(db,id,seed);
  await db.query(await fs.readFile(path.join(__dirname,'../../db/shared-directory/patches/20261016_self_service_account_requests_1372.sql'),'utf8'));
  const state=(await db.query(`SELECT has_database_privilege('cerp_app',current_database(),'CONNECT') AS business_connect,
   (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.app_roles'::regclass) AS role_table_owner,
   (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.cerp_directory_definer_fixture_1568()'::regprocedure) AS definer_owner,
   (SELECT count(*) FROM user_role_assignments) AS assignment_count`)).rows[0];
  if(state.business_connect||state.role_table_owner!=='cerp_app'||state.definer_owner!=='cerp_app'||state.assignment_count!=='1')throw Error('ISOLATION_OR_OWNER_CHANGED');
  await db.query('SET ROLE cerp_directory_app');await assertDirectoryApplicationRole(db);await db.query('RESET ROLE');
  const proof={result:'PASS',original_app_roles_42501_reproduced:true,canonical_fk_owner_preserved:true,canonical_security_definer_preserved:true,bootstrap_assignment_created:true,business_connect_denied:true,runtime_not_owner_or_superuser_or_business_member:true,synthetic_only:true,live_changed:false};
  await fs.writeFile(path.join(__dirname,'../../docs/testing/evidence/shared-directory-owner-acls-1568.json'),JSON.stringify(proof,null,2)+'\n');return proof;
 }finally{await db.end();}
}
main().then(proof=>console.log(JSON.stringify(proof))).catch(error=>{console.error(JSON.stringify({result:'FAIL',code:error.code??error.message}));process.exitCode=1;});
