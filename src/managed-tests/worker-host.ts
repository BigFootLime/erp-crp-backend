import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,createHash} from 'node:crypto';
import {createReadStream,constants} from 'node:fs';
import {parse} from 'dotenv';
import {z} from 'zod';
import {checkedChild,type ManagedHostConfig} from './host-config';
import {ordinalSchema,requireManagedId} from './model';
import {databaseConnection,pgCommand,sqlIdentifier,withDatabase,assertInstanceMarker} from './postgres-host';
import {verifyTemplate,assertBlankTemplate} from './template';
const run=promisify(execFile);
const manifestSchema=z.object({id:z.string(),ordinal:ordinalSchema,port:z.number().int().min(1024).max(65535),template_version:z.string(),state:z.enum(['ALLOCATED','READY','DELETING','DELETED']),snapshot:z.string().nullable(),snapshot_sha256:z.string().nullable()}).strict();
type Manifest=z.infer<typeof manifestSchema>;
async function digestFile(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file)) hash.update(chunk);return hash.digest('hex');}
async function atomicFile(file:string,content:string) {const temporary=`${file}.${randomBytes(8).toString('hex')}.tmp`,h=await fs.open(temporary,'wx',0o600);try{await h.writeFile(content);await h.sync();}finally{await h.close();}await fs.rename(temporary,file);}
async function freePort(){return new Promise<number>((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address || typeof address==='string') return reject(new Error('MANAGED_PORT_ALLOCATION_FAILED'));server.close(error=>error ? reject(error):resolve(address.port));});});}
async function waitForIdentity(port:number,id:string) {
  const end=Date.now()+90_000;
  while(Date.now()<end){try{const response=await fetch(`http://127.0.0.1:${port}/api/v1/environment`,{signal:AbortSignal.timeout(2000),redirect:'error'}),body=await response.json();if(response.ok && body.database===id && body.environment==='test') return;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}
  throw new Error('MANAGED_API_STARTUP_FAILED');
}
export class ManagedHostWorker {
  constructor(private readonly config:ManagedHostConfig,private readonly host:{identity:()=>Promise<{uid:number;gid:number}>;service:(action:'start'|'stop',id:string,envFile:string)=>Promise<void>}={
    identity:async()=>({uid:Number((await run('/usr/bin/id',['-u',config.app_user])).stdout.trim()),gid:Number((await run('/usr/bin/getent',['group',config.app_group])).stdout.trim().split(':')[2])}),
    service:async(action,id)=>{await run(config.systemctl,[action,`cerp-api-managed@${id}.service`],{timeout:30000});},
  }){}
  private async volume(){
    const root=await fs.lstat(this.config.data_root);
    if(!root.isDirectory() || root.isSymbolicLink() || (process.platform!=='win32' && (root.uid!==0 || (root.mode&0o022)!==0))) throw new Error('MANAGED_DATA_ROOT_NOT_PROTECTED');
    const marker=await checkedChild(this.config.data_root,'.cerp-managed-tests-volume'),stat=await fs.lstat(marker);
    if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('MANAGED_DATA_VOLUME_UNAVAILABLE');
    const h=await fs.open(marker,'r');try{const b=Buffer.alloc(1);if((await h.read(b,0,1,0)).bytesRead!==1) throw new Error('MANAGED_DATA_VOLUME_UNAVAILABLE');}finally{await h.close();}
  }
  private async resourcePreflight(){await this.volume();const disk=await fs.statfs(this.config.data_root,{bigint:true});if(os.freemem()<this.config.minimum_free_memory_mb*1024*1024 || disk.bavail*disk.bsize<BigInt(this.config.minimum_free_disk_mb)*1024n*1024n) throw new Error('MANAGED_HOST_CAPACITY_INSUFFICIENT');}
  private async files(id:string){requireManagedId(id);const dir=await checkedChild(this.config.control_root,'instances',id);await fs.mkdir(dir,{recursive:true,mode:0o700});return {dir,manifest:path.join(dir,'manifest.json'),env:path.join(dir,'api.env')};}
  private async readManifest(id:string,ordinal:number){const files=await this.files(id);try{const stat=await fs.lstat(files.manifest);if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('MANAGED_MANIFEST_INVALID');const manifest=manifestSchema.parse(JSON.parse(await fs.readFile(files.manifest,'utf8')));if(manifest.id!==id || manifest.ordinal!==ordinal) throw new Error('MANAGED_MANIFEST_IDENTITY_INVALID');return manifest;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') return null;throw error;}}
  private async saveManifest(m:Manifest){const files=await this.files(m.id);await atomicFile(files.manifest,JSON.stringify(m)+'\n');}
  private async exists(id:string){return withDatabase(this.config.admin_database_url,'postgres',async client=>(await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[requireManagedId(id)])).rows.length>0);}
  private async prepareFiles(id:string,port:number){
    const base=parse(await fs.readFile(this.config.source_env));const sourceUrl=new URL(base.DATABASE_URL??'');
    if(sourceUrl.pathname!=='/cerp_test' || !['localhost','127.0.0.1','[::1]'].includes(sourceUrl.hostname)) throw new Error('MANAGED_APP_DATABASE_SOURCE_INVALID');
    const adminUrl=new URL(this.config.admin_database_url),host=(url:URL)=>url.hostname==='localhost' ? '127.0.0.1':url.hostname;
    if(host(sourceUrl)!==host(adminUrl) || (sourceUrl.port||'5432')!==(adminUrl.port||'5432')) throw new Error('MANAGED_APP_CLUSTER_MISMATCH');
    const {uid,gid}=await this.host.identity();
    if(!Number.isSafeInteger(uid) || uid<1 || !Number.isSafeInteger(gid) || gid<1) throw new Error('MANAGED_APP_IDENTITY_INVALID');
    const data=await checkedChild(this.config.data_root,id),runtime=await checkedChild(this.config.control_root,'runtime',id);
    const roots={CERP_ROOT:runtime,CERP_STORAGE_ROOT:data,CERP_DOCUMENTS_ROOT:path.join(data,'documents'),CERP_GENERATED_ROOT:path.join(data,'generated'),CERP_INBOUND_ROOT:path.join(data,'inbound'),CERP_EXPORTS_ROOT:path.join(data,'exports'),CERP_TMP_ROOT:path.join(data,'tmp'),CERP_IMAGES_ROOT:path.join(data,'generated','images'),CERP_GED_VAULT_ROOT:path.join(data,'ged')};
    // Complete all directory/file writes while the new tree is still root-owned.
    // Permissions are published deepest-first only after the private env is durable.
    for(const directory of new Set(Object.values(roots))) await fs.mkdir(directory,{recursive:true,mode:0o750});
    await fs.chmod(path.dirname(runtime),0o711);
    const marker=path.join(roots.CERP_GED_VAULT_ROOT,'.cerp-ged-volume');try{await fs.writeFile(marker,`${id}\n`,{flag:'wx',mode:0o640});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST' || await fs.readFile(marker,'utf8')!==`${id}\n`) throw error;}
    for(const key of Object.keys(base)) if(/^(RESEND_|SMTP_|SENDGRID_|CERP_E2E_)/.test(key)) delete base[key];
    Object.assign(base,roots,{NODE_ENV:'production',PORT:String(port),DATABASE_URL:databaseConnection(base.DATABASE_URL,id),JWT_SECRET:randomBytes(48).toString('hex'),MFA_ROOT_KEY:randomBytes(32).toString('base64'),MFA_KEY_ID:id,AUTH_RATE_LIMIT_HASH_KEY:randomBytes(48).toString('hex'),CERP_MANAGED_TEST_ID:id,CERP_TEST_REGISTRATION_ENABLED:'true',PG_POOL_MAX:'3',CERP_API_RELEASE_ROOT:this.config.api_release,CERP_GED_SENTINEL:marker,CERP_GED_REQUIRE_SENTINEL:'true',CERP_UPLOAD_ADMIN_TRUST_ROOTS:[this.config.control_root,path.dirname(this.config.control_root),this.config.data_root,path.dirname(this.config.data_root)].join(',')});
    const content=Object.entries(base).map(([key,value])=>{if(!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) throw new Error('MANAGED_ENV_INVALID');return `${key}=${JSON.stringify(value)}`;}).join('\n')+'\n';
    const files=await this.files(id);await atomicFile(files.env,content);
    await this.repairPermissions(id,uid,gid);
  }
  private async repairPermissions(id:string,knownUid?:number,knownGid?:number){
    // The privileged CLI refuses every non-Linux platform. Windows qualification
    // adapts systemd/identity and does not certify POSIX ownership operations.
    if(process.platform!=='linux') return;
    const identity=knownUid!==undefined && knownGid!==undefined ? {uid:knownUid,gid:knownGid}:await this.host.identity(),{uid,gid}=identity;
    if(!Number.isSafeInteger(uid) || uid<1 || !Number.isSafeInteger(gid) || gid<1) throw new Error('MANAGED_APP_IDENTITY_INVALID');
    const data=await checkedChild(this.config.data_root,id),runtime=await checkedChild(this.config.control_root,'runtime',id);
    const directories=[data,...['documents','generated','inbound','exports','tmp','ged','generated/images'].map(s=>path.join(data,s)),runtime].sort((a,b)=>b.split(path.sep).length-a.split(path.sep).length);
    const targets=[{file:path.join(data,'ged','.cerp-ged-volume'),root:this.config.data_root,directory:false},...directories.map(file=>({file,root:file===runtime ? this.config.control_root:this.config.data_root,directory:true}))];
    for(const target of targets){
      await checkedChild(target.root,path.relative(target.root,target.file));
      const before=await fs.lstat(target.file),real=await fs.realpath(target.file);
      const relative=path.relative(await fs.realpath(target.root),real);
      if(before.isSymbolicLink() || (target.directory ? !before.isDirectory():!before.isFile()) || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('MANAGED_PERMISSION_PATH_INVALID');
      const handle=await fs.open(target.file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(target.directory ? constants.O_DIRECTORY??0:0));
      try{const opened=await handle.stat();if(opened.dev!==before.dev || opened.ino!==before.ino || await fs.realpath(target.file)!==real || (target.directory ? !opened.isDirectory():!opened.isFile())) throw new Error('MANAGED_PERMISSION_IDENTITY_CHANGED');
        if(opened.uid!==0 && opened.uid!==uid) throw new Error('MANAGED_PERMISSION_OWNER_INVALID');
        if(opened.uid===0){await handle.chown(uid,gid);await handle.chmod(target.directory ? 0o2770:0o640);}
      }finally{await handle.close();}
    }
  }
  async status(){try{await this.volume();await verifyTemplate(this.config);return {ready:true,template_version:this.config.template_version};}catch{return {ready:false,template_version:this.config.template_version};}}
  async create(id:string,ordinal:number){
    requireManagedId(id);ordinalSchema.parse(ordinal);await this.resourcePreflight();let manifest=await this.readManifest(id,ordinal);
    if(manifest?.state==='DELETED' || manifest?.state==='DELETING') throw new Error('MANAGED_INSTANCE_REMOVED');
    if(!manifest){await verifyTemplate(this.config);manifest={id,ordinal,port:await freePort(),template_version:this.config.template_version,state:'ALLOCATED',snapshot:null,snapshot_sha256:null};await this.saveManifest(manifest);}
    const files=await this.files(id);try{const stat=await fs.lstat(files.env);if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('MANAGED_ENV_INVALID');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;await this.prepareFiles(id,manifest.port);}
    await this.repairPermissions(id);
    if(!await this.exists(id)) {
      if(manifest.template_version!==this.config.template_version) throw new Error('MANAGED_TEMPLATE_RELEASE_MISMATCH');
      await withDatabase(this.config.admin_database_url,'postgres',async client=>{await client.query(`CREATE DATABASE ${sqlIdentifier(id)} TEMPLATE ${sqlIdentifier(this.config.template_database)}`);await client.query(`COMMENT ON DATABASE ${sqlIdentifier(id)} IS ${"'"+id+"'"}`);});
    }
    const ownership=await withDatabase(this.config.admin_database_url,'postgres',async client=>(await client.query<{owned:boolean;comment:string|null}>("SELECT pg_get_userbyid(datdba)=current_user AS owned,shobj_description(oid,'pg_database') AS comment FROM pg_database WHERE datname=$1",[id])).rows[0]);
    if(!ownership?.owned || (ownership.comment!==null && ownership.comment!==id)) throw new Error('MANAGED_DATABASE_NOT_OWNED');
    if(ownership.comment===null){
      // Resume only our durable ALLOCATED checkpoint and an untouched pinned template.
      if(manifest.state!=='ALLOCATED') throw new Error('MANAGED_DATABASE_NOT_OWNED');
      await withDatabase(this.config.admin_database_url,id,async client=>{await assertBlankTemplate(client);const meta=(await client.query('SELECT version FROM public.cerp_test_template_meta WHERE singleton=true')).rows[0];if(meta?.version!==manifest!.template_version)throw new Error('MANAGED_TEMPLATE_IDENTITY_MISMATCH');});
      await withDatabase(this.config.admin_database_url,'postgres',client=>client.query(`COMMENT ON DATABASE ${sqlIdentifier(id)} IS '${id}'`));
    }
    await withDatabase(this.config.admin_database_url,id,async client=>{
      const markerExists=(await client.query("SELECT to_regclass('public.cerp_managed_instance') IS NOT NULL AS ok")).rows[0]?.ok;
      if(!markerExists){await assertBlankTemplate(client);await client.query('BEGIN');try{await client.query("CREATE TABLE public.cerp_managed_instance(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),database_id text NOT NULL UNIQUE,ordinal integer NOT NULL CHECK(ordinal>=2),template_version text NOT NULL)");await client.query('INSERT INTO public.cerp_managed_instance(database_id,ordinal,template_version) VALUES($1,$2,$3)',[id,ordinal,manifest!.template_version]);await client.query('REVOKE ALL ON public.cerp_managed_instance FROM PUBLIC,cerp_app; GRANT SELECT ON public.cerp_managed_instance TO cerp_app');await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}}
    });
    const marker=await assertInstanceMarker(this.config,id,ordinal);if(marker.template_version!==manifest.template_version) throw new Error('MANAGED_TEMPLATE_IDENTITY_MISMATCH');
    await withDatabase(this.config.admin_database_url,'postgres',client=>client.query(`GRANT CONNECT ON DATABASE ${sqlIdentifier(id)} TO cerp_app`));
    await this.host.service('start',id,files.env);await waitForIdentity(manifest.port,id);manifest.state='READY';await this.saveManifest(manifest);
    return {id,port:manifest.port,template_version:manifest.template_version};
  }
  async delete(id:string,ordinal:number){
    requireManagedId(id);ordinalSchema.parse(ordinal);await this.volume();const manifest=await this.readManifest(id,ordinal);
    if(!manifest){
      // A resource/preflight failure can occur before a private manifest exists.
      // Only an entirely absent database/tree may be acknowledged as a no-op.
      if(await this.exists(id)) throw new Error('MANAGED_INSTANCE_NOT_REGISTERED');
      const data=await checkedChild(this.config.data_root,id);try{await fs.lstat(data);throw new Error('MANAGED_INSTANCE_NOT_REGISTERED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
      return {id,port:null,template_version:this.config.template_version,deleted:true};
    }
    if(manifest.state==='DELETED') return {id,port:null,template_version:manifest.template_version,deleted:true};
    manifest.state='DELETING';await this.saveManifest(manifest);
    await this.host.service('stop',id,(await this.files(id)).env);
    if(await this.exists(id)) {
      const metadata=await withDatabase(this.config.admin_database_url,'postgres',async client=>(await client.query<{allowed:boolean;owned:boolean;comment:string}>('SELECT datallowconn AS allowed,pg_get_userbyid(datdba)=current_user AS owned,shobj_description(oid,\'pg_database\') AS comment FROM pg_database WHERE datname=$1',[id])).rows[0]);
      if(!metadata?.owned || metadata.comment!==id) throw new Error('MANAGED_DATABASE_AUTHORITY_INVALID');
      if(metadata.allowed) await assertInstanceMarker(this.config,id,ordinal);
      else if(!manifest.snapshot || !manifest.snapshot_sha256) throw new Error('MANAGED_BACKUP_REQUIRED');
      const directory=await checkedChild(this.config.control_root,'archives',id);await fs.mkdir(directory,{recursive:true,mode:0o700});
      if(!manifest.snapshot){manifest.snapshot=path.join(directory,'database.dump');await pgCommand(this.config,'pg_dump',id,['--format=custom','--file',manifest.snapshot]);await pgCommand(this.config,'pg_restore',id,['--list',manifest.snapshot]);await pgCommand(this.config,'pg_restore',id,['--file',process.platform==='win32' ? 'NUL':'/dev/null',manifest.snapshot]);manifest.snapshot_sha256=await digestFile(manifest.snapshot);await this.saveManifest(manifest);}
      const snapshot=await checkedChild(this.config.control_root,'archives',id,'database.dump');
      if(manifest.snapshot!==snapshot || !manifest.snapshot_sha256 || await digestFile(snapshot)!==manifest.snapshot_sha256) throw new Error('MANAGED_BACKUP_INTEGRITY_INVALID');
      await withDatabase(this.config.admin_database_url,'postgres',async client=>{await client.query(`ALTER DATABASE ${sqlIdentifier(id)} ALLOW_CONNECTIONS false`);await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[id]);await client.query(`DROP DATABASE ${sqlIdentifier(id)}`);});
    }
    const data=await checkedChild(this.config.data_root,id),archive=await checkedChild(this.config.data_root,'archives',id);
    try{const stat=await fs.lstat(data);if(!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('MANAGED_DATA_PATH_INVALID');await fs.mkdir(path.dirname(archive),{recursive:true,mode:0o700});await fs.rename(data,archive);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
    manifest.state='DELETED';await this.saveManifest(manifest);return {id,port:null,template_version:manifest.template_version,deleted:true};
  }
}
