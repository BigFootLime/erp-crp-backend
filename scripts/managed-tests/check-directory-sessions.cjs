const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
process.env.NODE_ENV='test';require('ts-node/register/transpile-only');
const {Client,Pool}=require('pg'),jwt=require('jsonwebtoken');
const runtime=path.resolve(__dirname,'../../../cerp-onboarding-1563-runtime'),nonce=crypto.randomBytes(5).toString('hex'),root=path.join(runtime,`directory-session-${nonce}`),checks=[];
const directoryId=crypto.randomUUID(),source=`cerp_directory_${directoryId.replace(/-/g,'')}`,siteA=`cerp_test_${crypto.randomBytes(16).toString('hex')}`,siteB=`cerp_test_${crypto.randomBytes(16).toString('hex')}`;
const url=db=>`postgresql://cerp_fixture@127.0.0.1:15463/${db}`;let child,sourceDb,sitePool;
let diagnostics='';
const keys=new Map(['cerp_prod',siteA,siteB].map(site=>[site,crypto.randomBytes(32).toString('hex')]));
function check(name,ok){if(!ok)throw new Error(`CHECK_FAILED:${name}`);checks.push(name);}
async function main(){
 await fs.mkdir(root,{recursive:true,mode:0o700});
 const candidates=await Promise.all((await fs.readdir(runtime)).filter(n=>/^managed-[a-f0-9]{10}$/.test(n)).map(async n=>({n,at:(await fs.stat(path.join(runtime,n))).mtimeMs})));candidates.sort((a,b)=>b.at-a.at);
 const template=`cerp_test_template_fixture_${candidates[0].n.slice(8)}`,admin=new Client({connectionString:url('postgres')});await admin.connect();
 try{check('owned loopback fixture only',(await admin.query('SELECT current_user actor,inet_server_port() port')).rows[0].actor==='cerp_fixture');await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_directory_app') THEN CREATE ROLE cerp_directory_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; ELSE ALTER ROLE cerp_directory_app LOGIN; END IF; END $$");for(const db of [source,siteA,siteB])await admin.query(`CREATE DATABASE "${db}" TEMPLATE "${template}"`);}finally{await admin.end();}
 sourceDb=new Client({connectionString:url(source)});await sourceDb.connect();
 await require('./directory-company-fixture.cjs').prepareCanonicalCompanyFixture(sourceDb);
 await require('./directory-owner-fixture.cjs').prepareDirectoryOwnerFixture(sourceDb);
 const secret=`FixtureA1+${crypto.randomBytes(16).toString('hex')}`,{prepareOwnerBootstrap}=require('../../src/managed-tests/owner-bootstrap'),{installEmptyDirectory}=require('../../src/shared-directory/install');
 const seed=await prepareOwnerBootstrap({username:'DIRECTORY_FIXTURE',name:'FIXTURE',surname:'OWNER',email:`owner.${nonce}@example.invalid`,password:secret,weekly_hours:39,employment_type:'CDI',job_title:'Fixture owner'});await installEmptyDirectory(sourceDb,directoryId,seed);
 check('business database role cannot connect to credential authority',(await sourceDb.query("SELECT has_database_privilege('cerp_app',current_database(),'CONNECT') AS allowed")).rows[0].allowed===false);
 const patch=await fs.readFile(path.join(__dirname,'../../db/patches/20261014_shared_directory_sites_1568.sql'),'utf8');
 for(const site of [siteA,siteB]){const db=new Client({connectionString:url(site)});await db.connect();try{await require('./directory-company-fixture.cjs').prepareCanonicalCompanyFixture(db);await db.query(patch);await db.query("INSERT INTO users(username,password,name,surname,email,role,status) VALUES('DIRECTORY_FIXTURE','unusable','LEGACY','KEPT',$1,'Administrateur Systeme et Reseau','Inactive')",[`owner.${nonce}@example.invalid`]);}finally{await db.end();}}
 const keyFile=path.join(root,'callers.json');await fs.writeFile(keyFile,JSON.stringify([...keys].map(([site,key])=>({site,key}))),{mode:0o600});
 for(const folder of ['data','data/tmp','data/images'])await fs.mkdir(path.join(root,folder),{recursive:true,mode:0o700});
 child=spawn(process.execPath,['scripts/managed-tests/directory-fixture-service.cjs'],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,DATABASE_URL:url(source).replace('cerp_fixture@','cerp_directory_app@'),JWT_SECRET:crypto.randomBytes(48).toString('hex'),MFA_ROOT_KEY:crypto.randomBytes(32).toString('base64'),AUTH_RATE_LIMIT_HASH_KEY:crypto.randomBytes(48).toString('hex'),CERP_SHARED_DIRECTORY_ID:directoryId,CERP_DIRECTORY_CALLERS_FILE:keyFile,CERP_DIRECTORY_TEST_REGISTRATION_OPEN:'true',CERP_STORAGE_ROOT:path.join(root,'data'),CERP_TMP_ROOT:path.join(root,'data','tmp'),CERP_IMAGES_ROOT:path.join(root,'data','images'),CERP_DIRECTORY_FIXTURE_DIAGNOSTICS:'true'},stdio:['ignore','ignore','pipe']});child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-10000);});
 const {DirectoryClient}=require('../../src/shared-directory/client'),clientA=new DirectoryClient('http://127.0.0.1:8085/internal/directory',siteA,keys.get(siteA)),clientB=new DirectoryClient('http://127.0.0.1:8085/internal/directory',siteB,keys.get(siteB)),prod=new DirectoryClient('http://127.0.0.1:8085/internal/directory','cerp_prod',keys.get('cerp_prod'));
 let ready=false;for(let attempt=0;attempt<60;attempt++){try{await clientA.call('info',{});ready=true;break;}catch{await new Promise(r=>setTimeout(r,250));}}check('private authority starts',ready);
 const meta={ip:null,user_agent:null,device_type:null,os:null,browser:null},login=await clientA.call('login',{input:{username:seed.profile.username,password:secret},meta});
 check('password alone gives no session',login.status==='mfa_enrollment_required'&&!login.token&&!login.directory_session);
 await clientB.call('verify-mfa',{input:{challenge_token:login.challenge_token,code:'000000'},meta}).then(()=>check('challenge cannot cross sites',false),e=>check('challenge cannot cross sites',e.status===401));
 const {totpForStep}=require('../../src/module/auth/domain/mfa'),code=totpForStep(login.totp.secret,Math.floor(Date.now()/30000)),sessionA=await clientA.call('verify-mfa',{input:{challenge_token:login.challenge_token,code},meta});
 check('real MFA creates opaque site session',!!sessionA.directory_session&&!sessionA.token&&sessionA.identity.database===siteA&&sessionA.recovery_codes.length===10);
 await clientB.validate(sessionA.directory_session).then(()=>check('opaque session cannot cross sites',false),e=>check('opaque session cannot cross sites',e.status===401));
 const loginB=await clientB.call('login',{input:{username:seed.profile.username,password:secret},meta});check('second base reuses existing MFA without enrollment',loginB.status==='mfa_required'&&!loginB.totp);
 const sessionB=await clientB.call('verify-mfa',{input:{challenge_token:loginB.challenge_token,code:sessionA.recovery_codes[0]},meta});
 check('recovery method retained in session',sessionB.identity.mfa_method==='recovery_code');
 const status=await clientA.call('mfa-status',{directory_session:sessionA.directory_session,input:{},meta});check('recovery consumption shared across bases',status.recovery_codes_remaining===9);
 const sameCode=await clientA.call('login',{input:{username:seed.profile.username,password:secret},meta});await clientA.call('verify-mfa',{input:{challenge_token:sameCode.challenge_token,code:sessionA.recovery_codes[0]},meta}).then(()=>check('recovery code cannot be reused on another base',false),e=>check('recovery code cannot be reused on another base',e.status===401));
 process.env.DATABASE_URL=url(siteA);process.env.JWT_SECRET=crypto.randomBytes(48).toString('hex');sitePool=require('../../src/config/database').default;
 const site=require('../../src/shared-directory/site-runtime');await site.initializeSharedDirectorySite(sitePool,{CERP_SHARED_DIRECTORY_ENABLED:'true',CERP_SHARED_DIRECTORY_SITE:siteA,CERP_SHARED_DIRECTORY_ID:directoryId,CERP_DIRECTORY_SITE_CALL_KEY:keys.get(siteA)});
 const adapted=await site.directoryAuthenticationResult(sitePool,sessionA),claims=jwt.verify(adapted.token,process.env.JWT_SECRET);await site.validateSiteDirectoryToken(sitePool,claims);
 const local=(await sitePool.query('SELECT id,username,directory_username,directory_email FROM users WHERE directory_profile_id=$1::uuid',[sessionA.identity.profile_id])).rows[0];
 check('legacy account not overwritten or reused',local.id!==sessionA.identity.source_user_id&&local.username.startsWith('DIR_')&&local.directory_username===seed.profile.username&&(await sitePool.query("SELECT name FROM users WHERE username='DIRECTORY_FIXTURE'")).rows[0].name==='LEGACY');
 check('no MFA secret cloned into business base',(await sitePool.query('SELECT count(*) n FROM user_mfa_factors')).rows[0].n==='0');
 const {directoryAdminList}=require('../../src/shared-directory/admin.facade');const list=await directoryAdminList(sitePool,{user:claims});check('new roster excludes retained legacy accounts',list.length===1&&list[0].username===seed.profile.username&&list[0].id===local.id);
 const invitedInput={headers:{idempotencyKey:crypto.randomUUID()},body:{username:'INVITED_FIXTURE',name:'FIXTURE',surname:'INVITED',email:`invited.${nonce}@example.invalid`,role:'Administrateur Systeme et Reseau',roles:['Administrateur Systeme et Reseau'],status:'Inactive',country:'France',test_superadmin:true}};
 const invited=await clientA.call('admin-user-create',{directory_session:sessionA.directory_session,input:invitedInput});
 const inviteReplay=await clientA.call('admin-user-create',{directory_session:sessionA.directory_session,input:invitedInput});check('invited creation replays without duplicate profile',invited.profile.profile_id===inviteReplay.profile.profile_id&&inviteReplay.replayed&&invited.profile.is_superadmin&&invited.profile.status==='Inactive');
 const invitation=await clientA.call('admin-user-invite',{directory_session:sessionA.directory_session,input:{profile_id:invited.profile.profile_id,key:crypto.randomUUID()}});
 const activated=await clientB.call('account-activate',{input:{token:invitation.invitation.token,newPassword:secret},meta});check('invitation activates at common credential authority',activated.replayed===false);
 const avatarBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3U8AAAAASUVORK5CYII=','base64');
 const avatar=await clientA.call('avatar-upload',{directory_session:sessionA.directory_session,profile_id:sessionA.identity.profile_id,key:crypto.randomUUID(),filename:'fixture.png',mime:'image/png',base64:avatarBytes.toString('base64'),meta});
 const avatarB=await clientB.validate(sessionB.directory_session),download=await clientB.downloadAvatar(sessionB.directory_session,avatar.profile_picture_asset.asset_id);
 check('verified personal avatar is common across bases',avatarB.avatar_asset_id===avatar.profile_picture_asset.asset_id&&download.bytes.equals(avatarBytes)&&download.mime==='image/png');
 const company={biller_id:null,expected_updated_at:null,biller_name:'Synthetic fixture company',street:'Fixture street',house_number:'1',postal_code:'69000',city:'LYON',country:'FR',phone:'',email:`company.${nonce}@example.invalid`,legal_form:'SAS',siret:'12345678901234',vat_number:'',share_capital:1000,rcs_city:'LYON',rcs_number:'123456789',late_penalty_rate:12,recovery_indemnity:40,effective_from:new Date().toISOString().slice(0,10)};
 check('empty canonical company list reads without synthetic timestamp columns',(await clientA.call('company-list',{directory_session:sessionA.directory_session,input:{}})).length===0);
 const companyKey=crypto.randomUUID(),saved=await clientA.call('company-save',{directory_session:sessionA.directory_session,input:{company,key:companyKey}});
 const replayedCompany=await clientA.call('company-save',{directory_session:sessionA.directory_session,input:{company,key:companyKey}});
 check('company creation replay does not duplicate company or legal version',replayedCompany.biller_id===saved.biller_id&&(await sourceDb.query('SELECT count(*)::int n FROM factureur')).rows[0].n===1&&(await sourceDb.query('SELECT count(*)::int n FROM finance_legal_mentions')).rows[0].n===1);
 const companyList=await clientA.call('company-list',{directory_session:sessionA.directory_session,input:{}}),originalDates=(await sourceDb.query('SELECT creation_date::text,modification_date::text FROM factureur WHERE biller_id=$1::uuid',[saved.biller_id])).rows[0];
 check('canonical modification date retains public expected_updated_at field',companyList.length===1&&companyList[0].selected&&companyList[0].expected_updated_at===originalDates.modification_date);
 const {synchronizeDirectoryCompany}=require('../../src/shared-directory/company.projection');await synchronizeDirectoryCompany(sitePool,sessionA.directory_session);
 const firstCompany=(await sitePool.query('SELECT biller_name FROM factureur WHERE biller_id=$1::uuid',[saved.biller_id])).rows[0];check('canonical company and author projected without legacy ID reuse',firstCompany.biller_name===company.biller_name&&(await sitePool.query('SELECT created_by FROM finance_legal_mentions WHERE biller_id=$1::uuid',[saved.biller_id])).rows[0].created_by===local.id);
 const update={...company,biller_id:saved.biller_id,expected_updated_at:companyList[0].expected_updated_at,biller_name:'Updated synthetic company',street:'Updated fixture street'};
 const updateKey=crypto.randomUUID();await clientA.call('company-save',{directory_session:sessionA.directory_session,input:{company:update,key:updateKey}});
 await clientA.call('company-save',{directory_session:sessionA.directory_session,input:{company:update,key:updateKey}});
 const changed=(await sourceDb.query('SELECT biller_name,creation_date::text,modification_date::text FROM factureur WHERE biller_id=$1::uuid',[saved.biller_id])).rows[0];
 check('company update preserves creation date and increments optimistic token',changed.biller_name===update.biller_name&&changed.creation_date===originalDates.creation_date&&changed.modification_date!==originalDates.modification_date&&(await sourceDb.query('SELECT count(*)::int n FROM erp_setup_company_commands')).rows[0].n===2);
 await clientA.call('company-save',{directory_session:sessionA.directory_session,input:{company:{...update,biller_name:'Stale fixture change'},key:crypto.randomUUID()}}).then(()=>check('stale company edit rejected without rewriting history',false),e=>check('stale company edit rejected without rewriting history',e.status===409&&(e.code==='COMPANY_CHANGED'||e.message.includes('COMPANY_CHANGED'))));
 const projectionPool=new Pool({connectionString:url(siteA),options:'-c role=cerp_app'});try{
  check('company projection executes as limited business role',(await projectionPool.query('SELECT current_user actor')).rows[0].actor==='cerp_app');
  await synchronizeDirectoryCompany(projectionPool,sessionA.directory_session);
  const projected=(await projectionPool.query('SELECT biller_name,creation_date::text,modification_date::text FROM factureur WHERE biller_id=$1::uuid',[saved.biller_id])).rows[0];
  check('updated company dates and immutable legal history project under cerp_app',projected.biller_name===update.biller_name&&projected.creation_date===originalDates.creation_date&&projected.modification_date===changed.modification_date&&(await projectionPool.query('SELECT count(*)::int n FROM finance_legal_mentions')).rows[0].n===1);
 }finally{await projectionPool.end();}
 const secondPool=new Pool({connectionString:url(siteB)});try{
  await site.initializeSharedDirectorySite(secondPool,{CERP_SHARED_DIRECTORY_ENABLED:'true',CERP_SHARED_DIRECTORY_SITE:siteB,CERP_SHARED_DIRECTORY_ID:directoryId,CERP_DIRECTORY_SITE_CALL_KEY:keys.get(siteB)});
  await secondPool.query(`INSERT INTO cerp_directory_approved_actor_bindings(profile_id,user_id,directory_id,expected_username,expected_email,approved_command_id) VALUES($1::uuid,1,$2::uuid,$3,$4,$5::uuid)`,[sessionA.identity.profile_id,directoryId,seed.profile.username,seed.profile.email,seed.command_id]);
  const bound=await site.directoryAuthenticationResult(secondPool,{directory_session:sessionB.directory_session,identity:await clientB.validate(sessionB.directory_session)});
  check('only privileged explicit owner binding preserves historical actor',bound.user.id===1&&(await secondPool.query('SELECT count(*) n FROM users')).rows[0].n==='1');
  const {synchronizeDirectoryActor}=require('../../src/shared-directory/actor.runtime'),before=await synchronizeDirectoryActor(secondPool,1);
  check('PIN actor validated without a web MFA prompt',before.status==='Active'&&before.reenrollment_required===false);
  await sourceDb.query("UPDATE cerp_directory_memberships SET status='Inactive',version=version+1 WHERE profile_id=$1::uuid AND database_id=$2",[sessionA.identity.profile_id,siteB]);
  const withdrawn=await synchronizeDirectoryActor(secondPool,1);check('withdrawn base access rejects PIN actor and revokes local session epoch',withdrawn.status==='Inactive'&&withdrawn.session_epoch>before.session_epoch);
  await sourceDb.query("UPDATE cerp_directory_memberships SET status='Active',version=version+1 WHERE profile_id=$1::uuid AND database_id=$2",[sessionA.identity.profile_id,siteB]);
  await synchronizeDirectoryActor(secondPool,1);
  await sourceDb.query('UPDATE users SET mfa_reenrollment_required=true WHERE id=$1',[sessionA.identity.source_user_id]);
  check('account recovery blocks PIN until required enrollment is complete',(await synchronizeDirectoryActor(secondPool,1)).reenrollment_required===true);
  await sourceDb.query('UPDATE users SET mfa_reenrollment_required=false WHERE id=$1',[sessionA.identity.source_user_id]);
  const renewed=await clientB.call('login',{input:{username:seed.profile.username,password:secret},meta}),renewedB=await clientB.call('verify-mfa',{input:{challenge_token:renewed.challenge_token,code:sessionA.recovery_codes[1]},meta});sessionB.directory_session=renewedB.directory_session;
  await synchronizeDirectoryCompany(secondPool,sessionB.directory_session);check('same company UUID and legal history in second Test',(await secondPool.query('SELECT biller_id FROM factureur')).rows[0].biller_id===saved.biller_id&&(await secondPool.query('SELECT count(*) n FROM finance_legal_mentions')).rows[0].n==='1');
 }finally{await secondPool.end();}
 await site.initializeSharedDirectorySite(sitePool,{CERP_SHARED_DIRECTORY_ENABLED:'true',CERP_SHARED_DIRECTORY_SITE:siteA,CERP_SHARED_DIRECTORY_ID:directoryId,CERP_DIRECTORY_SITE_CALL_KEY:keys.get(siteA)});
 const securitySql=`SELECT u.password,u.role,u.status,u.mfa_reenrollment_required,
  coalesce(e.session_epoch,0)::text AS epoch,
  (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.database_id) FROM cerp_directory_memberships m WHERE m.profile_id=p.profile_id) AS memberships,
  (SELECT jsonb_agg(jsonb_build_object('id',f.id,'version',f.version,'state',f.state) ORDER BY f.id) FROM user_mfa_factors f WHERE f.user_id=u.id) AS factors
  FROM users u JOIN cerp_directory_profiles p ON p.user_id=u.id LEFT JOIN realtime_session_epochs e ON e.user_id=u.id WHERE u.id=$1`;
 const securityBefore=JSON.stringify((await sourceDb.query(securitySql,[sessionA.identity.source_user_id])).rows[0]);
 const ownInput={name:'  fixture family  ',surname:' élise ',email:`self.${nonce}@example.invalid`,tel_no:'+33 6 12 34 56 78'};
 await clientA.call('profile-self-update',{directory_session:sessionA.directory_session,input:ownInput,meta});
 const updatedA=await clientA.validate(sessionA.directory_session),updatedB=await clientB.validate(sessionB.directory_session);
 check('own personal identity and contact normalize at common authority',updatedA.name==='FIXTURE FAMILY'&&updatedA.surname==='ÉLISE'&&updatedA.email===ownInput.email&&updatedA.tel_no==='+33612345678');
 check('same personal profile visible immediately on a second base',updatedB.name===updatedA.name&&updatedB.email===updatedA.email&&updatedB.tel_no===updatedA.tel_no);
 await site.projectDirectoryIdentity(sitePool,updatedA);
 const ownLocal=await require('../../src/module/auth/repository/self-profile.repository').readSelfProfile(local.id);
 check('own profile exposes canonical contact despite retained legacy email collision',ownLocal.username===seed.profile.username&&ownLocal.email===updatedA.email&&ownLocal.name===updatedA.name&&ownLocal.tel_no===updatedA.tel_no);
 for(const input of [{role:'Administrateur Systeme et Reseau'},{is_superadmin:true},{profile_id:invited.profile.profile_id},{mfa_reenrollment_required:true}])await clientA.call('profile-self-update',{directory_session:sessionA.directory_session,input,meta}).then(()=>check('own profile rejects target or privileged fields',false),e=>check('own profile rejects target or privileged fields',e.status===400));
 await clientB.call('profile-self-update',{directory_session:sessionA.directory_session,input:{name:'CROSS SITE'},meta}).then(()=>check('personal update rejects cross-site session',false),e=>check('personal update rejects cross-site session',e.status===401));
 await clientA.call('profile-self-update',{directory_session:sessionA.directory_session,input:{email:invited.profile.email},meta}).then(()=>check('personal email collision preserves existing profiles',false),e=>check('personal email collision preserves existing profiles',e.status===409&&e.code==='PROFILE_EMAIL_IN_USE'));
 await clientA.call('profile-self-update',{directory_session:sessionA.directory_session,input:{avatar_key:'programmer'},meta});
 const preset=await clientB.validate(sessionB.directory_session);
 check('selecting a preset replaces uploaded avatar on all bases',preset.avatar_key==='programmer'&&preset.avatar_asset_id===null);
 await clientA.call('profile-self-update',{directory_session:sessionA.directory_session,input:{avatar_key:'programmer'},meta});
 check('repeated personal save does not duplicate audit',(await sourceDb.query("SELECT count(*)::int n FROM erp_audit_logs WHERE action='AUTH_SELF_PROFILE_UPDATED'")).rows[0].n===2);
 check('personal changes preserve roles memberships password and MFA',JSON.stringify((await sourceDb.query(securitySql,[sessionA.identity.source_user_id])).rows[0])===securityBefore);
 check('personal change never modifies another account',(await sourceDb.query('SELECT email FROM users WHERE id=$1',[invited.profile.source_user_id])).rows[0].email===invited.profile.email);
 const {synchronizeDirectoryActor}=require('../../src/shared-directory/actor.runtime');check('legacy PIN actor without approved UUID is rejected',await synchronizeDirectoryActor(sitePool,1)===null);
 const input={username:'TEST_ONLY_FIXTURE',name:'FIXTURE',surname:'MEMBER',email:`test.${nonce}@example.invalid`,password:secret,avatar_key:'duck',weekly_hours_target:35,daily_hours_target:7,day_start:'08:00',day_end:'16:00',break_minutes:60,working_days:[1,2,3,4,5]};
 const created=await clientA.call('register',{input,key:crypto.randomUUID(),meta});check('public registration still starts with MFA',created.status==='mfa_enrollment_required');
 const roster=await clientA.call('profile-roster',{directory_session:sessionA.directory_session}),newProfile=roster.find(p=>p.username===input.username);await site.projectDirectoryProfile(sitePool,newProfile);
 const hours=(await sitePool.query('SELECT c.weekly_hours_target,c.daily_hours_target FROM hr_employment_contracts c JOIN hr_employees e ON e.id=c.employee_id JOIN users u ON u.id=e.user_id WHERE u.directory_profile_id=$1::uuid',[newProfile.profile_id])).rows[0];check('new common profile seeds canonical local work hours',Number(hours.weekly_hours_target)===35&&Number(hours.daily_hours_target)===7);
 await prod.call('login',{input:{username:input.username,password:secret},meta}).then(()=>check('Test superAdmin never auto grants Production',false),e=>check('Test superAdmin never auto grants Production',e.status===401));
 await sourceDb.query('UPDATE users SET status=\'Blocked\' WHERE id=$1',[sessionA.identity.source_user_id]);
 for(const client of [clientA,clientB])await client.validate(client===clientA?sessionA.directory_session:sessionB.directory_session).then(()=>check('blocked identity immediately rejected on both bases',false),e=>check('blocked identity immediately rejected on both bases',e.status===401));
 return {result:'PASS',checks,synthetic_identities_only:true,scanner_fixture_only:true,dedicated_database_role:true,canonical_cerp_app_fk_and_definer_owners:true,live_prod_changed:false,live_test_changed:false};
}
main().then(async report=>{await fs.writeFile(path.join(__dirname,'../../docs/testing/evidence/shared-directory-sessions-1568.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({result:report.result,checks:checks.length}));}).catch(async e=>{await new Promise(r=>setTimeout(r,250));await fs.writeFile(path.join(root,'fixture-diagnostic.log'),diagnostics,{mode:0o600});console.error(JSON.stringify({result:'FAIL',checks:checks.length,failed_check:e.message?.startsWith('CHECK_FAILED:')?e.message:e.code??e.name,permission_object:/permission denied for (?:table|sequence|function) ([a-z_][a-z0-9_]*)/.exec(e.message??'')?.[1]??null,frames:String(e.stack??'').split('\n').filter(line=>/^\s+at /.test(line)).slice(0,4),diagnostic_file:path.join(root,'fixture-diagnostic.log')}));for(const line of diagnostics.split('\n')){try{const record=JSON.parse(line);if(record.type==='directory_fixture_diagnostic')console.error(JSON.stringify(record));}catch{}}process.exitCode=1;}).finally(async()=>{if(child)child.kill();if(sitePool)await sitePool.end();if(sourceDb)await sourceDb.end();});
