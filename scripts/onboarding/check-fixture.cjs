// Real PostgreSQL/API checks. Loopback disposable cluster only; no real data or credentials.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
process.env.DATABASE_URL='postgresql://cerp_fixture@127.0.0.1:15463/cerp_test';
process.env.NODE_ENV='test';process.env.JWT_SECRET=crypto.randomBytes(48).toString('hex');
process.env.MFA_ROOT_KEY=crypto.randomBytes(32).toString('base64');
require('ts-node/register/transpile-only');
const pool=require('../../src/config/database').default;
const request=require('supertest');
const express=require('express');
const app=express();app.use(express.json());
app.use('/api/v1/auth',require('../../src/module/auth/routes/auth.routes').default);
app.use('/api/v1/admin/onboarding',require('../../src/module/onboarding/routes/onboarding.routes').default);
app.use((error,_req,res,_next)=>res.status(error.status ?? (error.name==='ZodError' ? 400 : 500)).json({code:error.code ?? error.name}));
const {totpForStep,hashChallengeToken}=require('../../src/module/auth/domain/mfa');
const checks=[];
function check(name,condition){if(!condition)throw new Error(`CHECK_FAILED:${name}`);checks.push(name);}
function httpStatus(name,res,status){check(`${name} (${status}; actual=${res.status}; code=${res.body?.code ?? res.body?.error ?? 'none'})`,res.status===status);}
const root=path.resolve(__dirname,'../..');
const sql=name=>fs.readFileSync(path.join(root,'db/patches',name),'utf8');
const patch='20261014_initial_setup_1563.sql';
const report={at:new Date().toISOString(),database:'local disposable cerp_test',port:15463,checks,live_test_changed:false,live_prod_changed:false};
async function main(){
 const client=await pool.connect();
 try{
  const identity=await client.query("SELECT current_database() AS db,current_user AS actor,inet_server_port() AS port");
  check('isolated database identity',identity.rows[0].db==='cerp_test' && identity.rows[0].actor==='cerp_fixture' && identity.rows[0].port===15463);
  await client.query(sql(`support/${patch.replace('.sql','.preflight.sql')}`));check('preflight',true);
  await client.query(sql(`support/${patch.replace('.sql','.verify.sql')}`));check('verify',true);
  await client.query(sql(`support/${patch.replace('.sql','.rollback.sql')}`));check('unused schema rollback',true);
  await client.query(sql(patch));await client.query(sql(patch));check('apply and reapply',true);
 }finally{client.release();}
 const options=await request(app).get('/api/v1/auth/test-registration');httpStatus('closed options',options,200);check('closed by default',options.body.enabled===false);
 const input={username:'ONBOARDING.FIXTURE',name:'élise',surname:'recette',email:'onboarding-fixture@example.test',password:'Fixture!Onboarding1',avatar_key:'programmer',weekly_hours_target:35,daily_hours_target:7,day_start:'08:00',day_end:'16:00',break_minutes:60,working_days:[1,2,3,4,5]};
 const key=crypto.randomUUID();
 const post=body=>request(app).post('/api/v1/auth/test-registration').set('Idempotency-Key',key).send(body);
 httpStatus('closed registration',await post({...input,username:'CLOSED.FIXTURE',email:'closed-fixture@example.test'}),403);
 process.env.CERP_TEST_REGISTRATION_ENABLED='true';
 httpStatus('role injection rejected',await post({...input,username:'INVALID.FIXTURE',email:'invalid-fixture@example.test',role:'Directeur',is_superadmin:true,database:'cerp_test'}),400);
 const responses=await Promise.all([post(input),post(input)]);
 check('concurrent command creates one account',[responses[0].status,responses[1].status].sort().join(',')==='200,201');
 check('no session before MFA',responses.every(r=>r.body.status==='mfa_enrollment_required' && !r.body.token));
 const account=await pool.query("SELECT id,is_superadmin,name,surname,avatar_key FROM public.users WHERE username=$1",[input.username]);
 check('canonical identity, imposed privilege, avatar',account.rows.length===1 && account.rows[0].is_superadmin && account.rows[0].name==='ÉLISE' && account.rows[0].surname==='RECETTE' && account.rows[0].avatar_key==='programmer');
 const userId=account.rows[0].id;
 const hr=await pool.query(`SELECT c.weekly_hours_target,c.daily_hours_target,count(s.id)::int AS days FROM public.hr_employees e
  JOIN public.hr_employment_contracts c ON c.employee_id=e.id JOIN public.hr_work_schedules s ON s.employee_id=e.id WHERE e.user_id=$1 GROUP BY c.id`,[userId]);
 check('canonical RH targets and five schedules',Number(hr.rows[0].weekly_hours_target)===35 && Number(hr.rows[0].daily_hours_target)===7 && hr.rows[0].days===5);
 let enrollment;
 for(const response of responses){const active=await pool.query('SELECT id FROM public.auth_mfa_challenges WHERE token_hash=$1 AND used_at IS NULL',[hashChallengeToken(response.body.challenge_token)]);if(active.rows.length)enrollment=response.body;}
 check('latest MFA challenge usable',!!enrollment);
 const verified=await request(app).post('/api/v1/auth/mfa/verify').send({challenge_token:enrollment.challenge_token,code:totpForStep(enrollment.totp.secret,Math.floor(Date.now()/30000))});
 httpStatus('MFA enrollment verification',verified,200);check('recovery codes returned once',verified.body.recovery_codes?.length===10);
 const token=verified.body.token;const authed=(method,url)=>request(app)[method](url).set('Authorization',`Bearer ${token}`);
 const me=await authed('get','/api/v1/auth/me');httpStatus('authenticated profile',me,200);check('avatar retained after MFA',me.body.user.avatar_key==='programmer');
 const status=await authed('get','/api/v1/admin/onboarding/status');httpStatus('real configuration facts',status,200);
 check('hours ready, setup incomplete, first-login reminder',status.body.sections.hours && !status.body.complete && status.body.show_reminder && status.body.login_count===1);
 const progress=await authed('put','/api/v1/admin/onboarding/progress').send({current_step:'maintenance'});httpStatus('persist wizard step',progress,204);
 check('resume persisted step',(await authed('get','/api/v1/admin/onboarding/status')).body.current_step==='maintenance');
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris'}).format(new Date());
 const company={biller_id:null,expected_updated_at:null,biller_name:'ENTREPRISE DE RECETTE',street:'Rue de la recette',house_number:'1',postal_code:'69000',city:'Lyon',country:'FR',phone:'',email:'societe@example.test',legal_form:'SAS',siret:'12345678900011',vat_number:'FR00123456789',share_capital:1000,rcs_city:'Lyon',rcs_number:'123456789',late_penalty_rate:12,recovery_indemnity:40,effective_from:today};
 const companyKey=crypto.randomUUID(),save=(body,key)=>authed('put','/api/v1/admin/onboarding/company').set('Idempotency-Key',key).send(body);
 const created=await save(company,companyKey);httpStatus('company canonical creation',created,200);
 const replay=await save(company,companyKey);httpStatus('company replay',replay,200);check('company replay retains same id',replay.body.biller_id===created.body.biller_id);
 let companies=await authed('get','/api/v1/admin/onboarding/company');httpStatus('company read',companies,200);
 let current=companies.body.find(row=>row.biller_id===created.body.biller_id);check('primary company selected',current.selected===true);
 const existing={...company,biller_id:current.biller_id,expected_updated_at:current.expected_updated_at};
 httpStatus('numeric legal values no unnecessary version',await save(existing,crypto.randomUUID()),200);
 const mentions=await pool.query('SELECT count(*)::int AS n FROM public.finance_legal_mentions WHERE biller_id=$1',[current.biller_id]);check('one legal version after unchanged save',mentions.rows[0].n===1);
 companies=await authed('get','/api/v1/admin/onboarding/company');current=companies.body.find(row=>row.biller_id===created.body.biller_id);
 httpStatus('backdated legal edits rejected',await save({...existing,expected_updated_at:current.expected_updated_at,legal_form:'SARL'},crypto.randomUUID()),409);
 const rollbackClient=await pool.connect();try{let refused=false;try{await rollbackClient.query(sql(`support/${patch.replace('.sql','.rollback.sql')}`));}catch(e){refused=e.code==='P0001';await rollbackClient.query('ROLLBACK');}check('data rollback refused',refused);}finally{rollbackClient.release();}
 check('account remains present',(await pool.query('SELECT id FROM public.users WHERE id=$1',[userId])).rows.length===1);
 report.patch_sha256=crypto.createHash('sha256').update(sql(patch)).digest('hex');report.result='PASS';
}
main().catch(error=>{report.result='FAIL';report.failure_code=error.code ?? error.name;report.failure_check=error.message?.startsWith('CHECK_FAILED:') ? error.message : undefined;process.exitCode=1;}).finally(async()=>{
 fs.mkdirSync(path.join(root,'docs/testing/evidence'),{recursive:true});fs.writeFileSync(path.join(root,'docs/testing/evidence/initial-setup-1563-postgres.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({result:report.result,checks:checks.length,failure:report.failure_check ?? report.failure_code ?? null}));await pool.end();
});
