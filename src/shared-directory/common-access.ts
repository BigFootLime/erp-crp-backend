import {createHash} from 'node:crypto';
import type {Express,RequestHandler} from 'express';
import type {Pool} from 'pg';
import {z} from 'zod';
import {directoryIdSchema,siteIdSchema} from './model';
import type {DirectoryClient} from './client';
import {signDirectoryCall,verifyDirectoryCall} from './call-signature';
import {directoryProfileForSite} from './admin.repository';
import {HttpError} from '../utils/httpError';
import {SENSITIVE_CAPABILITIES} from '../module/access-control/domain/sensitive-capabilities';
import {repoListCatalogModules,repoUpsertUserModuleAccess} from '../module/access-control/repository/access-control.repository';
import {bumpRealtimeAuthorizationEpoch} from '../shared/realtime/realtime-control-plane';
import {withRealtimeOutboxTransaction} from '../shared/realtime/realtime-outbox-transaction';
import {repoInsertAuditLog} from '../module/audit-logs/repository/audit-logs.repository';
import {commonAccessReplyMac,verifyCommonAccessReply} from './common-access-signature';

const SOURCE_PATH='/internal/cerp/common-access-v1';
const SOURCE_URL='http://127.0.0.1:8080'+SOURCE_PATH;
const MARKER='DIRECTORY_COMMON_ACCESS_PROJECTED';
const unavailable=()=>new HttpError(503,'DIRECTORY_UNAVAILABLE','Les droits communs sont momentanément indisponibles.');
// Production may read its own signed ACL snapshot for shared configuration;
// the projection endpoint below still rejects Production callers explicitly.
const bindingSchema=z.object({authority_id:directoryIdSchema,profile_id:z.string().guid(),target_site:siteIdSchema}).strict();
const dataSchema=bindingSchema.extend({
 epoch:z.string().regex(/^(0|[1-9][0-9]{0,39})$/),
 modules:z.array(z.object({module_key:z.string().min(1).max(100),allowed:z.boolean()}).strict()).max(1000),
 capabilities:z.array(z.enum(SENSITIVE_CAPABILITIES)).max(SENSITIVE_CAPABILITIES.length),
}).strict();
const replySchema=dataSchema.extend({policy_hash:z.string().regex(/^[a-f0-9]{64}$/),request_nonce:z.string().guid(),issued_at:z.number().int().positive()}).strict();
export type CommonAccessPolicy=z.infer<typeof replySchema>;
const policyHash=(value:z.infer<typeof dataSchema>)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function policyData(policy:CommonAccessPolicy){
 return dataSchema.parse(Object.fromEntries(Object.keys(dataSchema.shape).map(key=>[key,policy[key as keyof CommonAccessPolicy]])));
}

/** Only the Production API reads its own current ACLs. No credentials leave Directory. */
export function mountCommonAccessSource(app:Express,db:Pool,env:NodeJS.ProcessEnv=process.env){
 app.post(SOURCE_PATH,(req,res,next)=>{void(async()=>{
  if(env.CERP_SHARED_DIRECTORY_ENABLED!=='true'||env.CERP_SHARED_DIRECTORY_SITE!=='cerp_prod'){res.sendStatus(404);return;}
  const key=env.CERP_DIRECTORY_SITE_CALL_KEY??'';
  if(!/^[a-f0-9]{64}$/.test(key))throw unavailable();
  const body=Buffer.from(JSON.stringify(req.body));
  if(body.length>16384)throw unavailable();
  let call:ReturnType<typeof verifyDirectoryCall>;
  try{call=verifyDirectoryCall(Object.fromEntries(Object.entries(req.headers).map(([k,v])=>[k,typeof v==='string'?v:undefined])),new Map([['cerp_prod',key]]),'POST',SOURCE_PATH,body);}
  catch{res.status(401).json({code:'COMMON_ACCESS_CALL_REJECTED'});return;}
  const binding=bindingSchema.parse(req.body);
  if(binding.authority_id!==env.CERP_SHARED_DIRECTORY_ID)throw unavailable();
  const tx=await db.connect();let data:z.infer<typeof dataSchema>;
  try{
   // A repeatable-read snapshot binds every grant/revocation to one source epoch.
   // This endpoint performs no mutation; a repeated signed read has no side effect.
   await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const source=(await tx.query<{database:string;epoch:string;id:number}>(`SELECT current_database() AS database,e.epoch::text,u.id FROM public.realtime_authorization_epoch e
    JOIN public.users u ON u.directory_profile_id=$1::uuid WHERE e.singleton`,[binding.profile_id])).rows[0];
   if(source?.database!=='cerp_prod')throw unavailable();
   const modules=(await tx.query<{module_key:string;allowed:boolean}>(`SELECT m.module_key,
    (m.is_active AND NOT m.is_protected AND coalesce(a.access='GRANTED',false)) AS allowed
    FROM public.app_modules m LEFT JOIN public.app_module_user_access a ON a.module_key=m.module_key AND a.user_id=$1 ORDER BY m.module_key`,[source.id])).rows;
   const capabilities=(await tx.query<{capability:typeof SENSITIVE_CAPABILITIES[number]}>('SELECT capability FROM public.app_user_sensitive_capabilities WHERE user_id=$1 AND granted ORDER BY capability',[source.id])).rows.map(row=>row.capability);
   if(!modules.length)throw unavailable();
   data=dataSchema.parse({...binding,epoch:source.epoch,modules,capabilities});
   await tx.query('COMMIT');
  }catch(error){await tx.query('ROLLBACK').catch(()=>undefined);throw error;}finally{tx.release();}
  const reply:CommonAccessPolicy={...data,policy_hash:policyHash(data),request_nonce:call.nonce,issued_at:Math.floor(Date.now()/1000)};
  const bytes=Buffer.from(JSON.stringify(reply));
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-CERP-Common-Access-Signature',commonAccessReplyMac('source',key,call.nonce,bytes).toString('hex'));
  res.type('application/json').send(bytes);
 })().catch(next);});
}

export async function readCommonAccessSource(binding:z.infer<typeof bindingSchema>,key:string,transport:typeof fetch=fetch):Promise<CommonAccessPolicy>{
 try{
  const body=Buffer.from(JSON.stringify(binding)),headers=signDirectoryCall('cerp_prod',key,'POST',SOURCE_PATH,body);
  const response=await transport(SOURCE_URL,{method:'POST',body,headers:{...headers,'Content-Type':'application/json'},signal:AbortSignal.timeout(8000),redirect:'error',cache:'no-store'});
  if(!response.ok||Number(response.headers.get('content-length'))>65536)throw unavailable();
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>65536)throw unavailable();
  const signature=response.headers.get('x-cerp-common-access-signature')??'';
  if(!verifyCommonAccessReply('source',key,headers['X-CERP-Directory-Nonce'],bytes,signature))throw unavailable();
  const policy=replySchema.parse(JSON.parse(bytes.toString('utf8')));
  if(policy.request_nonce!==headers['X-CERP-Directory-Nonce']||Math.abs(Math.floor(Date.now()/1000)-policy.issued_at)>10||policy.authority_id!==binding.authority_id||policy.profile_id!==binding.profile_id||policy.target_site!==binding.target_site||policy.policy_hash!==policyHash(policyData(policy)))throw unavailable();
  if(new Set(policy.modules.map(m=>m.module_key)).size!==policy.modules.length||new Set(policy.capabilities).size!==policy.capabilities.length)throw unavailable();
  return policy;
 }catch{throw unavailable();}
}

export function mountDirectoryCommonAccess(app:Express,db:Pool,authorityId:string,keys:()=>Promise<ReadonlyMap<string,string>>,wrap:(work:any)=>RequestHandler,transport:typeof fetch=fetch){
 app.post('/internal/directory/common-access-policy',wrap(async(req:any,res:any)=>{
  const input=z.object({profile_id:z.string().guid()}).strict().parse(req.body),site=req.directoryCaller!;
  if(site==='cerp_prod')throw new HttpError(403,'COMMON_ACCESS_TEST_REQUIRED','Cette projection est réservée aux bases Test.');
  const allowed=await keys();if(!allowed.has(site))throw unavailable();
  const send=(value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value));res.setHeader('Cache-Control','no-store');res.setHeader('X-CERP-Common-Access-Site-Signature',commonAccessReplyMac('site',allowed.get(site)!,req.directoryRequestNonce!,bytes).toString('hex'));res.type('application/json').send(bytes);};
  const profile=await directoryProfileForSite(db,site,input.profile_id);
  if(profile.status!=='Active')throw new HttpError(401,'DIRECTORY_SESSION_REJECTED','Une nouvelle connexion est requise.');
  const production=(await db.query<{status:string}>("SELECT status FROM public.cerp_directory_memberships WHERE profile_id=$1::uuid AND database_id='cerp_prod'",[input.profile_id])).rows[0];
  // Test-only registrations retain their site rights and never obtain Production.
  if(!production){send({policy:null});return;}
  if(production.status!=='Active')throw new HttpError(401,'DIRECTORY_SESSION_REJECTED','Une nouvelle connexion est requise.');
  const key=allowed.get('cerp_prod');if(!key)throw unavailable();
  send({policy:await readCommonAccessSource({authority_id:authorityId,profile_id:input.profile_id,target_site:site},key,transport)});
 }));
}

/** Runs before issuing a Test JWT and before each HTTP/Socket authorization. */
export async function synchronizeCommonAccess(db:Pool,directory:DirectoryClient,site:string,profileId:string){
 if(site==='cerp_prod')return;
 try{
  const response=z.object({policy:replySchema.nullable()}).strict().parse(await directory.commonAccessPolicy(profileId));
  if(!response.policy)return;
  const policy=response.policy;
  if(policy.profile_id!==profileId||policy.target_site!==site||policy.authority_id!==process.env.CERP_SHARED_DIRECTORY_ID||Math.abs(Math.floor(Date.now()/1000)-policy.issued_at)>20||policy.policy_hash!==policyHash(policyData(policy)))throw unavailable();
  await withRealtimeOutboxTransaction(await db.connect(),async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['common-access:'+profileId]);
   const user=(await tx.query<{id:number}>('SELECT id FROM public.users WHERE directory_profile_id=$1::uuid AND status=\'Active\' FOR UPDATE',[profileId])).rows[0];
   if(!user)throw unavailable();
   const previous=(await tx.query<{epoch:string;hash:string}>(`SELECT details->>'source_epoch' AS epoch,details->>'policy_hash' AS hash FROM public.erp_audit_logs
    WHERE user_id=$3 AND action=$1 AND entity_type='directory_profile' AND entity_id=$2 AND path='/internal/directory/common-access-policy'
    ORDER BY (details->>'source_epoch')::numeric DESC,created_at DESC LIMIT 1`,[MARKER,profileId,user.id])).rows[0];
   if(previous&&(BigInt(previous.epoch)>BigInt(policy.epoch)||(previous.epoch===policy.epoch&&previous.hash!==policy.policy_hash)))throw unavailable();
   if(previous?.epoch===policy.epoch&&previous.hash===policy.policy_hash)return;
   if(previous?.hash!==policy.policy_hash){
    const catalog=await repoListCatalogModules(tx),known=new Set(catalog.map(m=>m.module_key)),grants=new Map(policy.modules.map(m=>[m.module_key,m.allowed]));
    if(policy.modules.some(m=>m.allowed&&!known.has(m.module_key)))throw unavailable();
    const current=new Map((await tx.query<{module_key:string;access:string}>('SELECT module_key,access FROM public.app_module_user_access WHERE user_id=$1',[user.id])).rows.map(row=>[row.module_key,row.access]));
    for(const module of catalog){
     const access=module.is_active&&!module.is_protected&&grants.get(module.module_key)===true?'GRANTED':'DENIED';
     if(current.get(module.module_key)!==access)await repoUpsertUserModuleAccess(tx,{userId:user.id,moduleKey:module.module_key,access,updatedBy:user.id});
    }
    const currentCaps=new Set((await tx.query<{capability:string}>('SELECT capability FROM public.app_user_sensitive_capabilities WHERE user_id=$1 AND granted',[user.id])).rows.map(row=>row.capability));
    if(JSON.stringify([...currentCaps].sort())!==JSON.stringify([...policy.capabilities].sort())){
     await tx.query('UPDATE public.app_user_sensitive_capabilities SET granted=false,version=version+1,updated_at=now(),updated_by=$2 WHERE user_id=$1 AND granted AND NOT(capability=ANY($3::text[]))',[user.id,user.id,policy.capabilities]);
     for(const capability of policy.capabilities)if(!currentCaps.has(capability))await tx.query(`INSERT INTO public.app_user_sensitive_capabilities(user_id,capability,granted,updated_by) VALUES($1,$2,true,$1)
      ON CONFLICT(user_id,capability) DO UPDATE SET granted=true,version=app_user_sensitive_capabilities.version+1,updated_at=now(),updated_by=$1`,[user.id,capability]);
     await bumpRealtimeAuthorizationEpoch(tx);
    }
   }
   // This server action is atomic with the ACL projection and attributed to
   // the projected account. Public telemetry is normalized to CLIENT_ACTION
   // / CLIENT_NAVIGATION by clientAuditEvent and cannot forge this marker.
   await repoInsertAuditLog({tx,user_id:user.id,ip:null,user_agent:null,device_type:null,os:null,browser:null,body:{event_type:'ACTION',action:MARKER,page_key:'administration-acces',entity_type:'directory_profile',entity_id:profileId,path:'/internal/directory/common-access-policy',details:{source_epoch:policy.epoch,policy_hash:policy.policy_hash,source_database:'cerp_prod',source:'server_directory_projection'}}});
  });
 }catch{throw unavailable();}
}
