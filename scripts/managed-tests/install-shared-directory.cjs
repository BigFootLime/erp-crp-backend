// Privileged, explicit installation only. No credential is accepted in argv or printed.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{Client}=require('pg'),{parse}=require('dotenv');
const {z}=require('zod'),{installEmptyDirectory}=require('../../dist/shared-directory/install'),{approveBootstrapOwnerActor}=require('../../dist/shared-directory/owner-actor-binding');
const {readDirectoryCallerKeys}=require('../../dist/shared-directory/caller-keys');
const absolute=z.string().refine(p=>path.isAbsolute(p)&&!p.includes('\0')&&!p.split('/').includes('..'));
const schema=z.object({directory_id:z.string().uuid(),template_database:z.string().regex(/^cerp_test_template_[a-z0-9_]{1,35}$/),admin_database_url:z.string().url(),owner_seed_file:absolute,directory_env_file:absolute,callers_file:absolute,data_root:absolute,database_secret_file:absolute,fixed_site_env_files:z.object({cerp_prod:absolute,cerp_test:absolute}).strict()}).strict();
async function privateFile(file){const stat=await fs.lstat(file),parent=await fs.lstat(path.dirname(file));if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o077)!==0||parent.uid!==0||(parent.mode&0o022)!==0||parent.isSymbolicLink())throw Error('DIRECTORY_PRIVATE_INSTALL_FILE_REQUIRED');return fs.readFile(file,'utf8');}
async function writePrivate(file,value){const parent=await fs.lstat(path.dirname(file));if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==0||(parent.mode&0o022)!==0)throw Error('DIRECTORY_PRIVATE_INSTALL_PARENT_REQUIRED');const temp=`${file}.${crypto.randomBytes(8).toString('hex')}.tmp`,handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}await fs.rename(temp,file);}
const sqlId=name=>'"'+name.replace(/"/g,'""')+'"';
async function main(){
 if(process.platform!=='linux'||process.getuid()!==0||process.argv.length!==3)throw Error('DIRECTORY_ROOT_INSTALL_REQUIRED');
 const config=schema.parse(JSON.parse(await privateFile(process.argv[2]))),adminUrl=new URL(config.admin_database_url);
 if(!['postgres:','postgresql:'].includes(adminUrl.protocol)||!['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname)||adminUrl.pathname!=='/postgres')throw Error('DIRECTORY_LOCAL_CLUSTER_REQUIRED');
 const seed=JSON.parse(await privateFile(config.owner_seed_file)),database=`cerp_directory_${config.directory_id.replace(/-/g,'')}`;
 let credentials;try{credentials=JSON.parse(await privateFile(config.database_secret_file));}catch(error){if(error.code!=='ENOENT')throw error;credentials={directory_id:config.directory_id,database,password:crypto.randomBytes(32).toString('hex'),jwt:crypto.randomBytes(48).toString('hex'),mfa:crypto.randomBytes(32).toString('base64'),rate:crypto.randomBytes(48).toString('hex')};await writePrivate(config.database_secret_file,JSON.stringify(credentials)+'\n');}
 if(credentials.directory_id!==config.directory_id||credentials.database!==database||![credentials.password,credentials.jwt,credentials.rate].every(s=>typeof s==='string'&&/^[a-f0-9]{64,96}$/.test(s)))throw Error('DIRECTORY_PRIVATE_SECRET_IDENTITY_INVALID');
 const admin=new Client({connectionString:config.admin_database_url});await admin.connect();
 try{
  const role=(await admin.query("SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname='cerp_directory_app'")).rows[0];
  if(role&&(role.rolsuper||role.rolcreatedb||role.rolcreaterole))throw Error('DIRECTORY_DATABASE_ROLE_PRIVILEGED');
  // The generated hex password has no SQL metacharacters and remains only in private files.
  await admin.query(`${role?'ALTER':'CREATE'} ROLE cerp_directory_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${credentials.password}'`);
  const exists=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rows.length>0;
  if(!exists){await admin.query(`CREATE DATABASE ${sqlId(database)} TEMPLATE ${sqlId(config.template_database)} ALLOW_CONNECTIONS false`);await admin.query(`REVOKE CONNECT ON DATABASE ${sqlId(database)} FROM PUBLIC,cerp_app; GRANT CONNECT ON DATABASE ${sqlId(database)} TO cerp_directory_app; ALTER DATABASE ${sqlId(database)} ALLOW_CONNECTIONS true`);}
 }finally{await admin.end();}
 const sourceUrl=new URL(config.admin_database_url);sourceUrl.pathname=`/${database}`;const source=new Client({connectionString:sourceUrl.toString()});await source.connect();
 let installed;try{
  installed=await installEmptyDirectory(source,config.directory_id,seed);
  for(const site of ['cerp_prod','cerp_test']){const url=new URL(config.admin_database_url);url.pathname=`/${site}`;const target=new Client({connectionString:url.toString()});await target.connect();try{await approveBootstrapOwnerActor(source,target,config.directory_id,seed.command_id);}finally{await target.end();}}
 }finally{await source.end();}
 let callers;try{callers=[...await readDirectoryCallerKeys(config.callers_file)].map(([site,key])=>({site,key}));}catch(error){if(error.code!=='ENOENT')throw error;callers=['cerp_prod','cerp_test'].map(site=>({site,key:crypto.randomBytes(32).toString('hex')}));await writePrivate(config.callers_file,JSON.stringify(callers)+'\n');}
 const appUrl=new URL(config.admin_database_url);appUrl.pathname=`/${database}`;appUrl.username='cerp_directory_app';appUrl.password=credentials.password;
 const env={NODE_ENV:'production',DATABASE_URL:appUrl.toString(),JWT_SECRET:credentials.jwt,MFA_ROOT_KEY:credentials.mfa,MFA_KEY_ID:config.directory_id,AUTH_RATE_LIMIT_HASH_KEY:credentials.rate,CERP_SHARED_DIRECTORY_ID:config.directory_id,CERP_DIRECTORY_CALLERS_FILE:config.callers_file,CERP_DIRECTORY_TEST_REGISTRATION_OPEN:'true',CERP_STORAGE_ROOT:config.data_root,CERP_TMP_ROOT:path.join(config.data_root,'tmp'),CERP_IMAGES_ROOT:path.join(config.data_root,'images'),CERP_UPLOAD_SCAN_MODE:'enforce',CERP_UPLOAD_SCAN_PROVIDER:'clamdscan',CERP_UPLOAD_SCANNER_COMMAND:'/usr/bin/clamdscan'};
 await writePrivate(config.directory_env_file,Object.entries(env).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n');
 for(const site of ['cerp_prod','cerp_test']){const old=parse(await privateFile(config.fixed_site_env_files[site])),key=callers.find(row=>row.site===site)?.key;if(!/^[a-f0-9]{64}$/.test(key??''))throw Error('DIRECTORY_FIXED_SITE_KEY_REQUIRED');Object.assign(old,{CERP_SHARED_DIRECTORY_ENABLED:'true',CERP_SHARED_DIRECTORY_ID:config.directory_id,CERP_SHARED_DIRECTORY_SITE:site,CERP_DIRECTORY_SITE_CALL_KEY:key});await writePrivate(`${config.fixed_site_env_files[site]}.shared-directory.new`,Object.entries(old).map(([name,value])=>{if(!/^[A-Z_][A-Z0-9_]*$/.test(name)||/[\r\n\0]/.test(value))throw Error('DIRECTORY_SITE_ENV_INVALID');return `${name}=${JSON.stringify(value)}`;}).join('\n')+'\n');}
 console.log(JSON.stringify({directory_id:config.directory_id,database,bootstrap_owner_ready:true,replayed:installed.replayed,fixed_site_files_staged:true,services_started:false}));
}
main().catch(error=>{console.error(JSON.stringify({result:'FAIL',code:/^DIRECTORY_[A-Z_]+$/.test(error.message)?error.message:'DIRECTORY_INSTALL_FAILED'}));process.exitCode=1;});
