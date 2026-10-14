// Disposable loopback PostgreSQL only. Scanner verdicts are a controlled fixture,
// not a ClamAV certification. No real Test/Prod data or credential is inherited.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const runtime=path.resolve(__dirname,'../../../cerp-onboarding-1563-runtime/avatar-fixture');
process.env.DATABASE_URL='postgresql://cerp_fixture@127.0.0.1:15463/cerp_test';
process.env.NODE_ENV='test';process.env.JWT_SECRET=crypto.randomBytes(48).toString('hex');
process.env.MFA_ROOT_KEY=crypto.randomBytes(32).toString('base64');process.env.CERP_TEST_REGISTRATION_ENABLED='true';
process.env.CERP_IMAGES_ROOT=path.join(runtime,'images');process.env.CERP_TMP_ROOT=path.join(runtime,'tmp');process.env.CERP_UPLOAD_SCAN_MODE='enforce';
fs.mkdirSync(runtime,{recursive:true});fs.mkdirSync(process.env.CERP_IMAGES_ROOT,{recursive:true});fs.mkdirSync(process.env.CERP_TMP_ROOT,{recursive:true});
require('ts-node/register/transpile-only');
const pool=require('../../src/config/database').default,request=require('supertest'),express=require('express');
const scanner=require('../../src/shared/uploads/upload-scanner');
scanner.setUploadScannerForTests({name:'controlled-avatar-fixture',scan:async()=>({status:'clean',provider:'controlled-avatar-fixture'})});
const app=express();app.use(express.json());
app.use('/api/v1/auth',require('../../src/module/auth/routes/auth.routes').default);
app.use('/api/v1/admin',require('../../src/module/admin/routes/admin.routes').default);
app.use('/api/v1/operational-media',require('../../src/module/auth/middlewares/auth.middleware').authenticateToken,require('../../src/module/operational-media/routes/operational-media.routes').default);
app.use((error,_req,res,_next)=>res.status(error.status ?? (error.name==='ZodError' ? 400:500)).json({code:error.code ?? error.name}));
const {totpForStep}=require('../../src/module/auth/domain/mfa');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=','base64');
const checks=[],report={at:new Date().toISOString(),port:15463,database:'local disposable cerp_test',scanner:'controlled fixture verdict (not a live ClamAV test)',checks,live_test_changed:false,live_prod_changed:false};
function check(name,condition){if(!condition)throw new Error(`CHECK_FAILED:${name}`);checks.push(name);}
function status(name,response,expected){check(`${name}: HTTP ${expected} (actual ${response.status}; code ${response.body?.code ?? 'none'})`,response.status===expected);}
const root=path.resolve(__dirname,'../..'),sql=file=>fs.readFileSync(path.join(root,'db/patches',file),'utf8'),patch='20261014_user_avatars_1563';
async function main(){
 const identity=(await pool.query('SELECT current_database() db,current_user actor,inet_server_port() port')).rows[0];
 check('isolated identity',identity.db==='cerp_test' && identity.actor==='cerp_fixture' && identity.port===15463);
 await pool.query(sql(`support/${patch}.preflight.sql`));await pool.query(sql(`${patch}.sql`));await pool.query(sql(`${patch}.sql`));await pool.query(sql(`support/${patch}.verify.sql`));check('migration apply/reapply/verify',true);
 const suffix=crypto.randomBytes(5).toString('hex'),input={username:`AVATAR.${suffix.toUpperCase()}`,name:'AVATAR',surname:'FIXTURE',email:`avatar-${suffix}@example.test`,password:'Fixture!Avatar12',avatar_key:'programmer',weekly_hours_target:35,daily_hours_target:7,day_start:'08:00',day_end:'16:00',break_minutes:60,working_days:[1,2,3,4,5]};
 const registration=await request(app).post('/api/v1/auth/test-registration').set('Idempotency-Key',crypto.randomUUID()).send(input);status('register fixture',registration,201);
 const verification=await request(app).post('/api/v1/auth/mfa/verify').send({challenge_token:registration.body.challenge_token,code:totpForStep(registration.body.totp.secret,Math.floor(Date.now()/30000))});status('real MFA',verification,200);
 const token=verification.body.token,userId=verification.body.user.id,key=crypto.randomUUID();
 const upload=(key,bytes=png)=>request(app).put('/api/v1/auth/me/avatar').set('Authorization',`Bearer ${token}`).set('Idempotency-Key',key).attach('avatar',bytes,{filename:'personal-fixture.png',contentType:'image/png'});
 status('anonymous upload denied',await request(app).put('/api/v1/auth/me/avatar').set('Idempotency-Key',key).attach('avatar',png,{filename:'avatar.png',contentType:'image/png'}),401);
 status('forged bytes rejected',await upload(crypto.randomUUID(),Buffer.from('not an image')),415);
 const responses=await Promise.all([upload(key),upload(key)]);responses.forEach((r,i)=>status(`concurrent upload ${i+1}`,r,200));check('concurrent image commands succeed once and replay',responses.filter(r=>r.body.replayed).length===1);
 const asset=responses[0].body.profile_picture_asset.asset_id;check('opaque response without paths',!!asset && !JSON.stringify(responses[0].body).match(/personal-fixture|images|quarantine|storage_key/));
 const registry=await pool.query('SELECT asset_id::text FROM public.user_avatar_commands WHERE idempotency_key=$1',[key]);check('single durable command',registry.rows.length===1 && registry.rows[0].asset_id===asset);
 const me=await request(app).get('/api/v1/auth/me').set('Authorization',`Bearer ${token}`);status('profile read',me,200);check('avatar persisted after MFA',me.body.user.profile_picture_asset.asset_id===asset);
 const content=await request(app).get(`/api/v1/operational-media/${asset}/content`).set('Authorization',`Bearer ${token}`);status('authorized private image',content,200);check('exact image bytes delivered',Buffer.isBuffer(content.body) && content.body.equals(png));
 status('same key with different bytes rejected',await upload(key,Buffer.concat([png,Buffer.from('different-fixture')])),409);
 scanner.setUploadScannerForTests({name:'controlled-avatar-fixture',scan:async()=>({status:'unavailable',provider:'controlled-avatar-fixture'})});status('unavailable scanner fails closed',await upload(crypto.randomUUID()),503);
 scanner.setUploadScannerForTests({name:'controlled-avatar-fixture',scan:async()=>({status:'clean',provider:'controlled-avatar-fixture'})});
 const next=await upload(crypto.randomUUID());status('replace avatar',next,200);check('replacement receives a new identity',next.body.profile_picture_asset.asset_id!==asset);
 status('detached previous image unavailable',await request(app).get(`/api/v1/operational-media/${asset}/content`).set('Authorization',`Bearer ${token}`),404);
 const adminInput={username:`INVITED.${suffix.toUpperCase()}`,name:'INVITED',surname:'FIXTURE',email:`invited-${suffix}@example.test`,role:'Administrateur Systeme et Reseau',roles:['Administrateur Systeme et Reseau'],status:'Inactive',avatar_key:'duck',test_superadmin:true,work_profile:{weekly_hours_target:35,daily_hours_target:7,day_start:'08:00',day_end:'16:00',break_minutes:60,working_days:[1,2,3,4,5]}};
 const adminKey=crypto.randomUUID(),create=()=>request(app).post('/api/v1/admin/users').set('Authorization',`Bearer ${token}`).set('Idempotency-Key',adminKey).send(adminInput);
 const created=await create();status('administrative profile creation',created,201);const invitedId=created.body.user.id;
 const replay=await create();status('administrative replay',replay,200);check('administrative retry retains one invited account',replay.body.user.id===invitedId && replay.body.replayed);
 const hr=(await pool.query(`SELECT u.status,u.is_superadmin,u.avatar_key,count(DISTINCT e.id)::int employees,count(DISTINCT c.id)::int contracts,count(DISTINCT s.id)::int days
  FROM public.users u JOIN public.hr_employees e ON e.user_id=u.id JOIN public.hr_employment_contracts c ON c.employee_id=e.id JOIN public.hr_work_schedules s ON s.employee_id=e.id WHERE u.id=$1 GROUP BY u.id`,[invitedId])).rows[0];
 check('inactive invitation with one RH contract and five schedules',hr.status==='Inactive' && hr.is_superadmin && hr.avatar_key==='duck' && hr.employees===1 && hr.contracts===1 && hr.days===5);
 status('admin can attach invited profile photo',await request(app).put(`/api/v1/admin/users/${invitedId}/avatar`).set('Authorization',`Bearer ${token}`).set('Idempotency-Key',crypto.randomUUID()).attach('avatar',png,{filename:'invited.png',contentType:'image/png'}),200);
 const activation=await request(app).post(`/api/v1/admin/users/${invitedId}/invitations`).set('Authorization',`Bearer ${token}`).set('Idempotency-Key',crypto.randomUUID()).send({});status('canonical invitation remains available',activation,201);
 process.env.CERP_TEST_REGISTRATION_ENABLED='false';
 status('closed test rejects privilege exception',await request(app).post('/api/v1/admin/users').set('Authorization',`Bearer ${token}`).set('Idempotency-Key',crypto.randomUUID()).send({...adminInput,username:`CLOSED.${suffix.toUpperCase()}`,email:`closed-${suffix}@example.test`}),403);
 check('closed privilege command rolls back account and RH',!(await pool.query('SELECT id FROM public.users WHERE username=$1',[`CLOSED.${suffix.toUpperCase()}`])).rows.length);
 report.result='PASS';report.patch_sha256=crypto.createHash('sha256').update(sql(`${patch}.sql`)).digest('hex');
}
main().catch(error=>{report.result='FAIL';report.failure_code=error.code ?? error.name;report.failure_check=error.message?.startsWith('CHECK_FAILED:') ? error.message:undefined;process.exitCode=1;}).finally(async()=>{fs.mkdirSync(path.join(root,'docs/testing/evidence'),{recursive:true});fs.writeFileSync(path.join(root,'docs/testing/evidence/user-avatars-1563-postgres.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({result:report.result,checks:checks.length,failure:report.failure_check ?? report.failure_code ?? null}));await pool.end();});
