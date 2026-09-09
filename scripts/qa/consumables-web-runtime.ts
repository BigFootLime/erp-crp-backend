/** Loopback-only test runtime. No workers, emails or production database. */
export {};
async function start(){
  if(process.env.CERP_CONSUMABLES_QA_WRITE!=='1047'||!process.env.DATABASE_URL)throw new Error('Test opt-in required');
  const url=new URL(process.env.DATABASE_URL);url.pathname='/cerp_test';process.env.DATABASE_URL=url.toString();
  const root='/tmp/cerp-1047-qa';process.env.CERP_ROOT=root;process.env.CERP_STORAGE_ROOT=root+'/data';
  for(const name of ['DOCUMENTS','GENERATED','INBOUND','EXPORTS','TMP','IMAGES','GED_VAULT'])process.env[`CERP_${name}_ROOT`]=`${root}/data/${name.toLowerCase()}`;
  process.env.NODE_ENV='test';process.env.JWT_SECRET=require('node:crypto').randomBytes(48).toString('hex');
  process.env.CERP_ANDROID_TERMINALS_ENABLED='true';
  process.env.TERMINAL_PIN_PEPPER=require('node:crypto').randomBytes(48).toString('hex');
  process.env.FRONTEND_URL='http://127.0.0.1:5147';process.env.BACKEND_URL='http://127.0.0.1:5148';process.env.CORS_ORIGINS='http://127.0.0.1:5147';
  for(const name of ['RESEND_API_KEY','RESEND_FROM','RESEND_API_BASE_URL','SMTP_HOST','SMTP_USER','SMTP_PASSWORD'])delete process.env[name];
  const pool=require('../../src/config/database').default;
  const database=(await pool.query('SELECT current_database() AS name')).rows[0];if(database.name!=='cerp_test')throw new Error('Test database required');
  // Dedicated fictional account; its public fixture password has no validity in
  // production. The live account/session checks remain enabled in the real app.
  const password=await require('bcrypt').hash('QA1047-Web-Only!2026',12);
  const user=(await pool.query(`INSERT INTO public.users(username,password,name,surname,email,role,status,is_superadmin)
    VALUES('QA1047_WEB',$1,'Recette','Fictive 1047','qa1047@invalid.example','Administrateur Systeme et Reseau','Active',false)
    ON CONFLICT(username) DO UPDATE SET password=EXCLUDED.password,status='Active',is_superadmin=false RETURNING id`,[password])).rows[0];
  await pool.query("INSERT INTO public.user_role_assignments(user_id,role_key,assigned_by) VALUES($1,'Administrateur Systeme et Reseau',$1) ON CONFLICT(user_id,role_key) DO NOTHING",[user.id]);
  await pool.query("INSERT INTO public.app_module_user_access(user_id,module_key,access,updated_by) SELECT $1,module_key,'GRANTED',$1 FROM public.app_modules WHERE module_key IN('stock','production','achats','receptions','fournisseurs','qualite','donnees-techniques') ON CONFLICT(user_id,module_key) DO UPDATE SET access='GRANTED'",[user.id]);
  // Prepare only the isolated QA roots, with the same private upload preflight
  // as the normal runtime. The real antivirus remains configured and enforced.
  const fs=require('node:fs');
  for(const name of ['', '/data', ...['documents','generated','inbound','exports','tmp','images','ged_vault'].map(n=>'/data/'+n)]){
    fs.mkdirSync(root+name,{recursive:true,mode:0o700});fs.chmodSync(root+name,0o700);
  }
  require('../../src/shared/uploads/secure-upload').preflightSecureUploadStorageRoots();
  const scanner=require('../../src/shared/uploads/upload-scanner').getUploadScannerStartupConfiguration();
  require('../../src/shared/observability/health').setScannerStartupState(scanner);
  if(!scanner.ready)throw new Error('The real QA upload scanner is unavailable');
  const app=require('../../src/config/app').default;
  const server=app.listen(5148,'127.0.0.1',()=>process.stdout.write('QA1047 web API ready on loopback:5148 / cerp_test\n'));
  async function stop(){server.close();await pool.query("UPDATE public.users SET status='Inactive' WHERE username='QA1047_WEB'");await pool.end();process.exit(0);}
  process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
}
start().catch((e:any)=>{process.stderr.write(JSON.stringify({result:'FAIL',code:e.code,message:String(e.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[redacted]')}));process.exit(1);});
