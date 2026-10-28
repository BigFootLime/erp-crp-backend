import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {Express} from 'express';
import type {Pool} from 'pg';
import {z} from 'zod';
import {HttpError} from '../utils/httpError';
import {directoryIdSchema} from './model';
import {signDirectoryCall,verifyDirectoryCall} from './call-signature';

const PATH='/internal/cerp/approved-account-access-v1';
const MAX_BYTES=32*1024;
const unavailable=()=>new HttpError(503,'DIRECTORY_UNAVAILABLE','Les droits approuvés sont momentanément indisponibles.');
const sourceSiteSchema=z.enum(['cerp_prod','cerp_test']);
const requestSchema=z.object({authority_id:directoryIdSchema,profile_id:z.string().uuid(),source_site:sourceSiteSchema}).strict();
const snapshotDataSchema=requestSchema.extend({
 source_epoch:z.string().regex(/^(0|[1-9][0-9]{0,39})$/),
 module_keys:z.array(z.string().min(1).max(100)).max(1000),
}).strict();
const snapshotSchema=snapshotDataSchema.extend({
 source_hash:z.string().regex(/^[a-f0-9]{64}$/),request_nonce:z.string().uuid(),issued_at:z.number().int().positive(),
}).strict();
export type ApprovedAccountAccessSnapshot=z.infer<typeof snapshotSchema>;
export type ApprovedAccountAccessBinding=z.infer<typeof requestSchema>;

function snapshotData(value:ApprovedAccountAccessSnapshot){
 return snapshotDataSchema.parse(Object.fromEntries(Object.keys(snapshotDataSchema.shape).map(key=>[key,value[key as keyof ApprovedAccountAccessSnapshot]])));
}
function snapshotHash(value:z.infer<typeof snapshotDataSchema>){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function replyMac(key:string,nonce:string,body:Buffer){
 return createHmac('sha256',Buffer.from(key,'hex')).update(`CERP-APPROVED-ACCOUNT-ACCESS-SOURCE-RESPONSE-v1\n${PATH}\n${nonce}\n`).update(body).digest();
}
function verifyReply(key:string,nonce:string,body:Buffer,signature:string){
 return /^[a-f0-9]{64}$/.test(signature)&&timingSafeEqual(replyMac(key,nonce,body),Buffer.from(signature,'hex'));
}
function sourceUrl(site:z.infer<typeof sourceSiteSchema>){return `http://127.0.0.1:${site==='cerp_prod'?8080:8082}${PATH}`;}

/**
 * Serves a signed, current and deliberately minimal access snapshot from the
 * exact source site. It never projects ACLs or writes audit/authorization state.
 */
export function mountApprovedAccountAccessSource(app:Express,db:Pool,env:NodeJS.ProcessEnv=process.env){
 app.post(PATH,(req,res,next)=>{void(async()=>{
  if(env.CERP_SHARED_DIRECTORY_ENABLED!=='true') {res.sendStatus(404);return;}
  const configured=sourceSiteSchema.safeParse(env.CERP_SHARED_DIRECTORY_SITE);
  if(!configured.success){res.sendStatus(404);return;}
  const key=env.CERP_DIRECTORY_SITE_CALL_KEY??'';
  if(!/^[a-f0-9]{64}$/.test(key))throw unavailable();
  const body=Buffer.from(JSON.stringify(req.body));if(body.length>MAX_BYTES)throw unavailable();
  let call:ReturnType<typeof verifyDirectoryCall>;
  try{call=verifyDirectoryCall(Object.fromEntries(Object.entries(req.headers).map(([name,value])=>[name,typeof value==='string'?value:undefined])),new Map([[configured.data,key]]),'POST',PATH,body);}
  catch{res.status(401).json({code:'APPROVED_ACCESS_CALL_REJECTED'});return;}
  const binding=requestSchema.parse(req.body);
  if(binding.authority_id!==env.CERP_SHARED_DIRECTORY_ID||binding.source_site!==configured.data||call.site!==binding.source_site)throw unavailable();
  const tx=await db.connect();
  try{
   // One read-only snapshot binds source epoch, account state and effective ACL.
   await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const source=(await tx.query<{database:string;epoch:string;id:number;is_superadmin:boolean}>(`SELECT current_database() AS database,e.epoch::text,u.id,COALESCE(u.is_superadmin,false) AS is_superadmin
    FROM public.realtime_authorization_epoch e JOIN public.users u ON u.directory_profile_id=$1::uuid
    WHERE e.singleton AND u.status='Active'`,[binding.profile_id])).rows[0];
   if(!source||source.database!==binding.source_site)throw unavailable();
   const catalog=(await tx.query<{module_key:string;is_active:boolean;is_protected:boolean;access:'GRANTED'|'DENIED'|null}>(`SELECT m.module_key,m.is_active,m.is_protected,a.access
    FROM public.app_modules m LEFT JOIN public.app_module_user_access a ON a.user_id=$1 AND a.module_key=m.module_key
    ORDER BY m.module_key`,[source.id])).rows;
   if(!catalog.length||new Set(catalog.map(row=>row.module_key)).size!==catalog.length)throw unavailable();
   const module_keys=catalog.filter(row=>source.is_superadmin||(row.is_active&& !row.is_protected&&row.access==='GRANTED')).map(row=>row.module_key);
   const data=snapshotDataSchema.parse({...binding,source_epoch:source.epoch,module_keys});
   await tx.query('COMMIT');
   const reply:ApprovedAccountAccessSnapshot={...data,source_hash:snapshotHash(data),request_nonce:call.nonce,issued_at:Math.floor(Date.now()/1000)};
   const bytes=Buffer.from(JSON.stringify(reply));
   res.setHeader('Cache-Control','no-store');res.setHeader('X-CERP-Approved-Account-Access-Signature',replyMac(key,call.nonce,bytes).toString('hex'));
   res.type('application/json').send(bytes);
  }catch(error){await tx.query('ROLLBACK').catch(()=>undefined);throw error;}finally{tx.release();}
 })().catch(next);});
}

/** Directory-side client. The only accepted origins are the two local source APIs. */
export async function readApprovedAccountAccessSource(binding:ApprovedAccountAccessBinding,key:string,transport:typeof fetch=fetch):Promise<ApprovedAccountAccessSnapshot>{
 try{
  const checked=requestSchema.parse(binding);if(!/^[a-f0-9]{64}$/.test(key))throw unavailable();
  const body=Buffer.from(JSON.stringify(checked)),headers=signDirectoryCall(checked.source_site,key,'POST',PATH,body);
  const response=await transport(sourceUrl(checked.source_site),{method:'POST',body,headers:{...headers,'Content-Type':'application/json'},signal:AbortSignal.timeout(8000),redirect:'error',cache:'no-store'});
  if(!response.ok||Number(response.headers.get('content-length'))>MAX_BYTES)throw unavailable();
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>MAX_BYTES)throw unavailable();
  if(!verifyReply(key,headers['X-CERP-Directory-Nonce'],bytes,response.headers.get('x-cerp-approved-account-access-signature')??''))throw unavailable();
  const snapshot=snapshotSchema.parse(JSON.parse(bytes.toString('utf8'))),data=snapshotData(snapshot);
  if(snapshot.request_nonce!==headers['X-CERP-Directory-Nonce']||Math.abs(Math.floor(Date.now()/1000)-snapshot.issued_at)>10||snapshot.authority_id!==checked.authority_id||snapshot.profile_id!==checked.profile_id||snapshot.source_site!==checked.source_site||snapshot.source_hash!==snapshotHash(data)||new Set(snapshot.module_keys).size!==snapshot.module_keys.length)throw unavailable();
  return snapshot;
 }catch{throw unavailable();}
}
