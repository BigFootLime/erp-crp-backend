import bcrypt from 'bcryptjs';
import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {Express,RequestHandler} from 'express';
import type {Pool,PoolClient} from 'pg';
import {validateDirectorySession,createDirectorySession,bindChallenge} from './session.repository';
import {directoryAuthMetaSchema} from './mfa.operations';
import {canonicalizeAuthUsername} from '../module/auth/domain/auth-identity';
import {accountRequiresMfa,normalizeMfaPolicy} from '../module/auth/domain/mfa-policy';
import {issueSessionToken} from '../module/auth/domain/session-token';
import {beginMfaAfterPassword} from '../module/auth/services/mfa.service';
import {repoInsertAuditLog} from '../module/audit-logs/repository/audit-logs.repository';
import {authRateLimitConfig} from '../config/auth-rate-limit';

const session=z.string().regex(/^dir_[a-f0-9]{64}$/);
const pin=z.string().regex(/^\d{4}$/);
const deviceId=z.string().uuid();
const deviceSecret=z.string().regex(/^[a-f0-9]{64}$/);
const pairingCode=z.string().regex(/^[a-f0-9]{32}$/);
const deviceName=z.string().trim().min(1).max(80);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const equalHash=(expected:string,actual:string)=>{const a=Buffer.from(expected,'hex'),b=Buffer.from(actual,'hex');return a.length===b.length&&timingSafeEqual(a,b);};
const envelope=z.object({directory_session:session,meta:directoryAuthMetaSchema}).strict();
const PIN_LOCK_ATTEMPTS=5, PIN_LOCK_MINUTES=15, PAIRING_MINUTES=15;
const authError=()=>Object.assign(new Error('AUTH_INVALID'),{status:401,code:'AUTH_INVALID'});
const directoryAdminError=()=>Object.assign(new Error('Directory administrator access is required.'),{status:403,code:'DIRECTORY_ADMIN_REQUIRED'});
const tabletDeviceNotFound=()=>Object.assign(new Error('TABLET_DEVICE_NOT_FOUND'),{status:404,code:'TABLET_DEVICE_NOT_FOUND'});
const pinOnlySchemaUnavailable=()=>Object.assign(new Error('DIRECTORY_PIN_ONLY_SCHEMA_UNAVAILABLE'),{status:503,code:'DIRECTORY_PIN_ONLY_SCHEMA_UNAVAILABLE'});
const rawPairingCode=()=>randomBytes(16).toString('hex');
/** Separate from limiter subjects so a stored PIN lookup cannot be correlated with them. */
const pinHmac=(domain:string,value:string)=>{
 const key=authRateLimitConfig.hashKey;
 if(key.length<32)throw new Error('DIRECTORY_PIN_LOOKUP_KEY_UNAVAILABLE');
 return createHmac('sha256',key).update(`v1\0${domain}\0${value}`,'utf8').digest('hex');
};
const pinLookupHash=(value:string)=>pinHmac('directory-tablet-pin-lookup',value);
const pinVerifier=(value:string)=>pinHmac('directory-tablet-pin-verifier',value);
const pinKeyFingerprint=()=>pinHmac('directory-tablet-pin-key-fingerprint','');
const PIN_VERIFIER_VERSION=2;

type DeviceRow={device_id:string;device_secret_hash:string|null;revoked_at:string|null};
type LoginRow={pin_hash:string|null;pin_verifier_version:number|null;profile_id:string;id:number;username:string;password:string;mfa_required:boolean;is_superadmin:boolean;mfa_reenrollment_required:boolean;role:string;roles:string[];member_superadmin:boolean;status:string;user_status:string;session_epoch:number|string;mfa_policy:string|null;has_factor:boolean;pin_version:number};

/** Credentials are Directory-only. A tablet is a neutral facility asset, not a user credential. */
export function mountDirectoryTabletPins(app:Express,db:Pool,sourceJwtSecret:string,wrap:(work:any)=>RequestHandler){
 const audit=async(client:PoolClient,actor:any,meta:any,action:string,entityId:string,details:Record<string,unknown>={})=>repoInsertAuditLog({tx:client,user_id:actor.source_user_id,ip:meta.ip,user_agent:meta.user_agent,device_type:meta.device_type,os:meta.os,browser:meta.browser,body:{event_type:'ACTION',action,page_key:'tablet-pin',entity_type:'tablet_device',entity_id:entityId,path:'/auth/tablet-pin',details}});
 const requireAdmin=async(actor:any,site:string)=>{const allowed=(await db.query(`SELECT 1 FROM public.cerp_directory_memberships m JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id JOIN public.users u ON u.id=p.user_id WHERE m.profile_id=$1::uuid AND m.database_id=$2 AND m.status='Active' AND (m.is_superadmin OR u.is_superadmin)`,[actor.profile_id,site])).rows.length>0;if(!allowed)throw directoryAdminError();};
 const status=(row:any)=>row.revoked_at?'revoked':row.device_secret_hash?'paired':'pending_pairing';
 const rateLimit=async(client:PoolClient,scope:'ip'|'account_device',value:string,limit=PIN_LOCK_ATTEMPTS)=>{
  const key=hash(value);const row=(await client.query<{attempts:number;locked_until:string|null}>(`INSERT INTO public.cerp_directory_tablet_rate_limits(scope,key_hash,attempts,window_started_at) VALUES($1,$2,1,now()) ON CONFLICT(scope,key_hash) DO UPDATE SET attempts=CASE WHEN public.cerp_directory_tablet_rate_limits.locked_until>now() THEN public.cerp_directory_tablet_rate_limits.attempts WHEN public.cerp_directory_tablet_rate_limits.window_started_at<now()-interval '15 minutes' THEN 1 ELSE public.cerp_directory_tablet_rate_limits.attempts+1 END,window_started_at=CASE WHEN public.cerp_directory_tablet_rate_limits.locked_until>now() THEN public.cerp_directory_tablet_rate_limits.window_started_at WHEN public.cerp_directory_tablet_rate_limits.window_started_at<now()-interval '15 minutes' THEN now() ELSE public.cerp_directory_tablet_rate_limits.window_started_at END,locked_until=CASE WHEN public.cerp_directory_tablet_rate_limits.locked_until>now() THEN public.cerp_directory_tablet_rate_limits.locked_until WHEN public.cerp_directory_tablet_rate_limits.window_started_at>=now()-interval '15 minutes' AND public.cerp_directory_tablet_rate_limits.attempts+1>=${limit} THEN now()+interval '${PIN_LOCK_MINUTES} minutes' ELSE NULL END RETURNING attempts,locked_until`,[scope,key])).rows[0];
  return !!row?.locked_until&&new Date(row.locked_until)>new Date();
 };
 const isRateLimited=async(client:PoolClient,scope:'ip'|'account_device',value:string)=>{const row=(await client.query<{locked_until:string|null}>(`SELECT locked_until FROM public.cerp_directory_tablet_rate_limits WHERE scope=$1 AND key_hash=$2`,[scope,hash(value)])).rows[0];return !!row?.locked_until&&new Date(row.locked_until)>new Date();};
 const pinOnlySchemaReady=async(client:Pick<PoolClient,'query'>)=>(await client.query<{ready:boolean}>(`SELECT count(*)=3 AND EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0] WHERE n.nspname='public' AND t.relname='cerp_directory_tablet_pins' AND c.relname='cerp_directory_tablet_pins_lookup_hash_uq' AND i.indisunique AND i.indisvalid AND i.indisready AND i.indnkeyatts=1 AND a.attname='pin_lookup_hash' AND pg_get_expr(i.indpred,i.indrelid)='(pin_lookup_hash IS NOT NULL)') AS ready FROM pg_attribute WHERE attrelid='public.cerp_directory_tablet_pins'::regclass AND NOT attisdropped AND attname=ANY(ARRAY['pin_lookup_hash','pin_verifier_version','pin_key_fingerprint'])`)).rows[0]?.ready===true;
 app.post('/internal/directory/tablet-pin-status',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);
  const ready=await pinOnlySchemaReady(db);const row=(await db.query<{configured:boolean;pin_only_ready:boolean}>(`SELECT pin_hash IS NOT NULL AS configured, pin_hash IS NOT NULL AND to_jsonb(p)->>'pin_lookup_hash' IS NOT NULL AND to_jsonb(p)->>'pin_verifier_version'=$2::text AND to_jsonb(p)->>'pin_key_fingerprint'=$3 AS pin_only_ready FROM public.cerp_directory_tablet_pins p WHERE profile_id=$1::uuid`,[actor.profile_id,PIN_VERIFIER_VERSION,pinKeyFingerprint()])).rows[0];res.json({configured:row?.configured===true,pinOnlyReady:ready&&row?.pin_only_ready===true});
 }));
 app.post('/internal/directory/tablet-pin-set',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({pin}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session),client=await db.connect();
  const limiter=`tablet-pin-set:${actor.profile_id}`;
  try{
   await client.query('BEGIN');
   if(!await pinOnlySchemaReady(client)){await client.query('COMMIT');throw pinOnlySchemaUnavailable();}
   if(await isRateLimited(client,'account_device',limiter)){await client.query('COMMIT');throw Object.assign(new Error('TOO_MANY_ATTEMPTS'),{status:429,code:'TOO_MANY_ATTEMPTS'});}
   if(await rateLimit(client,'account_device',limiter)){await client.query('COMMIT');throw Object.assign(new Error('TOO_MANY_ATTEMPTS'),{status:429,code:'TOO_MANY_ATTEMPTS'});}
   await client.query('SAVEPOINT tablet_pin_set_write');
   try {
    const pinRow=await client.query<{version:number}>(`INSERT INTO public.cerp_directory_tablet_pins(profile_id,pin_hash,pin_lookup_hash,pin_verifier_version,pin_key_fingerprint,version) VALUES($1::uuid,$2,$3,$4,$5,1) ON CONFLICT(profile_id) DO UPDATE SET pin_hash=excluded.pin_hash,pin_lookup_hash=excluded.pin_lookup_hash,pin_verifier_version=excluded.pin_verifier_version,pin_key_fingerprint=excluded.pin_key_fingerprint,version=public.cerp_directory_tablet_pins.version+1,changed_at=now() RETURNING version`,[actor.profile_id,await bcrypt.hash(pinVerifier(body.input.pin),12),pinLookupHash(body.input.pin),PIN_VERIFIER_VERSION,pinKeyFingerprint()]);
    await client.query('DELETE FROM public.cerp_directory_sessions WHERE profile_id=$1::uuid AND tablet_device_id IS NOT NULL',[actor.profile_id]);
    await client.query('UPDATE public.cerp_directory_challenges SET expires_at=now() WHERE tablet_pin_profile_id=$1::uuid',[actor.profile_id]);
    await audit(client,actor,body.meta,'TABLET_PIN_SET',actor.profile_id,{pin_version:pinRow.rows[0].version});
    await client.query('RELEASE SAVEPOINT tablet_pin_set_write');
    await client.query('COMMIT');res.json({ok:true});
   } catch(error) {
    const failure=error as {code?:string;constraint?:string};
    if(failure.code==='23505'&&failure.constraint==='cerp_directory_tablet_pins_lookup_hash_uq'){
     await client.query('ROLLBACK TO SAVEPOINT tablet_pin_set_write');
     await client.query('COMMIT');
     throw Object.assign(new Error('TABLET_PIN_UNAVAILABLE'),{status:409,code:'TABLET_PIN_UNAVAILABLE'});
    }
    throw error;
   }
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
 }));
 app.post('/internal/directory/tablet-pin-revoke',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session),client=await db.connect();try{await client.query('BEGIN');if(!await pinOnlySchemaReady(client)){await client.query('COMMIT');throw pinOnlySchemaUnavailable();}const pinRow=await client.query<{version:number}>('INSERT INTO public.cerp_directory_tablet_pins(profile_id,pin_hash,pin_lookup_hash,pin_verifier_version,pin_key_fingerprint,version) VALUES($1::uuid,NULL,NULL,NULL,NULL,1) ON CONFLICT(profile_id) DO UPDATE SET pin_hash=NULL,pin_lookup_hash=NULL,pin_verifier_version=NULL,pin_key_fingerprint=NULL,version=public.cerp_directory_tablet_pins.version+1,changed_at=now() RETURNING version',[actor.profile_id]);await client.query('DELETE FROM public.cerp_directory_sessions WHERE profile_id=$1::uuid AND tablet_device_id IS NOT NULL',[actor.profile_id]);await client.query('UPDATE public.cerp_directory_challenges SET expires_at=now() WHERE tablet_pin_profile_id=$1::uuid',[actor.profile_id]);await audit(client,actor,body.meta,'TABLET_PIN_REVOKED',actor.profile_id,{pin_version:pinRow.rows[0].version});await client.query('COMMIT');res.json({ok:true});}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }));
 app.post('/internal/directory/tablet-pin-admin-list',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);await requireAdmin(actor,req.directoryCaller!);
  const devices=(await db.query(`SELECT device_id::text AS "deviceId",label AS name,created_at::text AS "createdAt",last_used_at::text AS "lastUsedAt",revoked_at,device_secret_hash FROM public.cerp_directory_tablet_devices WHERE database_id=$1 ORDER BY created_at DESC`,[req.directoryCaller!])).rows.map(row=>({deviceId:row.deviceId,name:row.name,status:status(row),createdAt:row.createdAt,lastUsedAt:row.lastUsedAt}));res.json({devices});
 }));
 const createPairing=async(client:PoolClient,site:string,id:string,name?:string)=>{const code=rawPairingCode();if(name===undefined){await client.query('DELETE FROM public.cerp_directory_sessions WHERE tablet_device_id=$1::uuid',[id]);await client.query('UPDATE public.cerp_directory_challenges SET expires_at=now() WHERE tablet_device_id=$1::uuid',[id]);await client.query(`UPDATE public.cerp_directory_tablet_devices SET pairing_code_hash=$3,pairing_expires_at=now()+$4::int*interval '1 minute',device_secret_hash=NULL,paired_at=NULL,revoked_at=NULL,failed_attempts=0,locked_until=NULL WHERE device_id=$1::uuid AND database_id=$2`,[id,site,hash(code),PAIRING_MINUTES]);}else await client.query(`INSERT INTO public.cerp_directory_tablet_devices(device_id,database_id,label,pairing_code_hash,pairing_expires_at) VALUES($1::uuid,$2,$3,$4,now()+$5::int*interval '1 minute')`,[id,site,name,hash(code),PAIRING_MINUTES]);return {pairingCode:code,expiresAt:new Date(Date.now()+PAIRING_MINUTES*60000).toISOString()};};
 app.post('/internal/directory/tablet-pin-admin-create-device',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({name:deviceName}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session),site=req.directoryCaller!;await requireAdmin(actor,site);const client=await db.connect(),id=randomUUID();try{await client.query('BEGIN');const pairing=await createPairing(client,site,id,body.input.name);await audit(client,actor,body.meta,'TABLET_DEVICE_CREATED',id,{name:body.input.name});await client.query('COMMIT');res.status(201).json({device:{deviceId:id,name:body.input.name,status:'pending_pairing',createdAt:new Date().toISOString(),lastUsedAt:null},...pairing});}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }));
 app.post('/internal/directory/tablet-pin-admin-repair',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({device_id:deviceId}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session),site=req.directoryCaller!;await requireAdmin(actor,site);const client=await db.connect();try{await client.query('BEGIN');const device=await client.query('SELECT device_id FROM public.cerp_directory_tablet_devices WHERE device_id=$1::uuid AND database_id=$2 AND revoked_at IS NULL FOR UPDATE',[body.input.device_id,site]);if(!device.rows.length)throw tabletDeviceNotFound();const pairing=await createPairing(client,site,body.input.device_id);await audit(client,actor,body.meta,'TABLET_DEVICE_RENEWED',body.input.device_id);await client.query('COMMIT');res.json(pairing);}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }));
 app.post('/internal/directory/tablet-pin-admin-rename',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({device_id:deviceId,name:deviceName}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session),site=req.directoryCaller!;await requireAdmin(actor,site);const client=await db.connect();try{await client.query('BEGIN');const device=await client.query('UPDATE public.cerp_directory_tablet_devices SET label=$2 WHERE device_id=$1::uuid AND database_id=$3 AND revoked_at IS NULL RETURNING device_id',[body.input.device_id,body.input.name,site]);if(!device.rows.length)throw tabletDeviceNotFound();await audit(client,actor,body.meta,'TABLET_DEVICE_RENAMED',body.input.device_id,{name:body.input.name});await client.query('COMMIT');res.json({ok:true});}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }));
 app.post('/internal/directory/tablet-pin-admin-revoke',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({device_id:deviceId}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session),site=req.directoryCaller!;await requireAdmin(actor,site);const client=await db.connect();try{await client.query('BEGIN');const device=await client.query('UPDATE public.cerp_directory_tablet_devices SET revoked_at=now(),device_secret_hash=NULL,pairing_code_hash=NULL,pairing_expires_at=NULL WHERE device_id=$1::uuid AND database_id=$2 AND revoked_at IS NULL RETURNING device_id',[body.input.device_id,site]);if(!device.rows.length)throw tabletDeviceNotFound();await client.query('DELETE FROM public.cerp_directory_sessions WHERE tablet_device_id=$1::uuid',[body.input.device_id]);await client.query('UPDATE public.cerp_directory_challenges SET expires_at=now() WHERE tablet_device_id=$1::uuid',[body.input.device_id]);await audit(client,actor,body.meta,'TABLET_DEVICE_REVOKED',body.input.device_id);await client.query('COMMIT');res.json({ok:true});}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }));
 app.post('/internal/directory/tablet-pin-pair',wrap(async(req:any,res:any)=>{
  const body=z.object({input:z.object({pairing_code:pairingCode}).strict(),meta:directoryAuthMetaSchema}).strict().parse(req.body),site=req.directoryCaller!,client=await db.connect();try{await client.query('BEGIN');const limited=await isRateLimited(client,'ip',`pair:${body.meta.ip??'unknown'}`);const row=limited?undefined:(await client.query<any>('SELECT device_id::text,revoked_at,pairing_code_hash,pairing_expires_at,label FROM public.cerp_directory_tablet_devices WHERE pairing_code_hash=$1 AND database_id=$2 FOR UPDATE',[hash(body.input.pairing_code),site])).rows[0];if(!row||row.revoked_at||!row.pairing_expires_at||new Date(row.pairing_expires_at)<=new Date()){if(!limited)await rateLimit(client,'ip',`pair:${body.meta.ip??'unknown'}`,100);await client.query('COMMIT');throw authError();}const secret=randomBytes(32).toString('hex');await client.query('UPDATE public.cerp_directory_tablet_devices SET device_secret_hash=$2,pairing_code_hash=NULL,pairing_expires_at=NULL,paired_at=now(),failed_attempts=0,locked_until=NULL WHERE device_id=$1::uuid AND database_id=$3',[row.device_id,hash(secret),site]);await client.query('COMMIT');res.json({deviceId:row.device_id,deviceSecret:secret});}catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
 }));
 app.post('/internal/directory/tablet-pin-login',wrap(async(req:any,res:any)=>{
  const body=z.object({input:z.object({username:z.string().trim().min(2).max(254).transform(canonicalizeAuthUsername).optional(),device_id:deviceId,device_secret:deviceSecret,pin}).strict(),meta:directoryAuthMetaSchema}).strict().parse(req.body),site=req.directoryCaller!,client=await db.connect();
  const limiter={ip:`tablet-pin:${body.meta.ip??'unknown'}`,device:`tablet-pin:${body.input.device_id}`};
  const selectAccount=`SELECT p.pin_hash,p.pin_verifier_version,p.version AS pin_version,p.profile_id,u.id,u.username,u.password,u.mfa_required,u.is_superadmin,u.mfa_reenrollment_required,u.role,coalesce((SELECT array_agg(ura.role_key) FROM public.user_role_assignments ura WHERE ura.user_id=u.id),ARRAY[u.role]) AS roles,m.is_superadmin AS member_superadmin,m.status,u.status AS user_status,coalesce(e.session_epoch,0) AS session_epoch,(SELECT value_text FROM public.erp_settings WHERE key='security.mfa_policy') AS mfa_policy,EXISTS(SELECT 1 FROM public.user_mfa_factors f WHERE f.user_id=u.id AND f.state='ACTIVE') AS has_factor FROM public.cerp_directory_profiles dp JOIN public.users u ON u.id=dp.user_id JOIN public.cerp_directory_memberships m ON m.profile_id=dp.profile_id AND m.database_id=$1 JOIN public.cerp_directory_tablet_pins p ON p.profile_id=dp.profile_id LEFT JOIN public.realtime_session_epochs e ON e.user_id=u.id`;
  try{await client.query('BEGIN');
   // Validate the paired device before any account/PIN lookup. This keeps a
   // stolen PIN from probing accounts through another tablet or another site.
   const device=(await client.query<DeviceRow>('SELECT device_id::text,device_secret_hash,revoked_at FROM public.cerp_directory_tablet_devices WHERE device_id=$1::uuid AND database_id=$2 FOR UPDATE',[body.input.device_id,site])).rows[0];
   const deviceValid=!!device&&!device.revoked_at&&!!device.device_secret_hash&&equalHash(device.device_secret_hash,hash(body.input.device_secret));
   const throttled=await isRateLimited(client,'ip',limiter.ip)||await isRateLimited(client,'account_device',limiter.device);
   if(!deviceValid||throttled){if(!throttled){await rateLimit(client,'ip',limiter.ip,100);if(deviceValid)await rateLimit(client,'account_device',limiter.device);}await client.query('COMMIT');if(throttled)throw Object.assign(new Error('TOO_MANY_ATTEMPTS'),{status:429,code:'TOO_MANY_ATTEMPTS'});throw authError();}
   if(!await pinOnlySchemaReady(client)){await client.query('COMMIT');throw pinOnlySchemaUnavailable();}
   const row=(await client.query<LoginRow>(`${selectAccount} WHERE p.pin_lookup_hash=$2 AND p.pin_verifier_version=${PIN_VERIFIER_VERSION} AND p.pin_key_fingerprint=$3 FOR UPDATE OF p`,[site,pinLookupHash(body.input.pin),pinKeyFingerprint()])).rows[0];
   const valid=!!row&&!row.mfa_reenrollment_required&&row.status==='Active'&&row.user_status==='Active'&&typeof row.pin_hash==='string'&&(!body.input.username||canonicalizeAuthUsername(row.username)===body.input.username)&&await bcrypt.compare(pinVerifier(body.input.pin),row.pin_hash);
   if(!valid){await rateLimit(client,'ip',limiter.ip,100);await rateLimit(client,'account_device',limiter.device);await client.query('COMMIT');throw authError();}
   // Keep failed guesses for the whole device window: a known valid PIN must
   // not let one employee reset the budget while guessing another user's PIN.
   const required=accountRequiresMfa({policy:normalizeMfaPolicy(row.mfa_policy),isSuperadmin:row.is_superadmin||row.member_superadmin,role:row.role,roles:row.roles,hasActiveFactor:row.has_factor,mfaRequired:row.mfa_required});
   await client.query('UPDATE public.cerp_directory_tablet_devices SET last_used_at=now() WHERE device_id=$1::uuid AND database_id=$2',[body.input.device_id,site]);
   // MFA locks the user in a separate transaction. Its work must finish before
   // the audit insert takes the user foreign-key lock in this transaction.
   const recordPinLogin=()=>repoInsertAuditLog({tx:client,user_id:row.id,ip:body.meta.ip,user_agent:body.meta.user_agent,device_type:body.meta.device_type,os:body.meta.os,browser:body.meta.browser,body:{event_type:'ACTION',action:'AUTH_TABLET_PIN_LOGIN',page_key:'tablet-pin',entity_type:'tablet_device',entity_id:body.input.device_id,path:'/auth/tablet-pin/login',details:{mfa_required:required}}});
   if(required){const challenge=await beginMfaAfterPassword({id:row.id,password:row.password} as any,{...body.meta,path:`/directory/${site}/auth/tablet-pin`});if(!challenge)throw new Error('DIRECTORY_MFA_REQUIRED');await bindChallenge(client,site,challenge.challenge_token,900,body.input.device_id,row.pin_version,row.profile_id);await recordPinLogin();await client.query('COMMIT');res.json(challenge);return;}
   await recordPinLogin();
   const source=issueSessionToken({id:row.id,username:row.username,email:null,role:row.role,realtime_session_epoch:Number(row.session_epoch)}).token;const directorySession=await createDirectorySession(client,site,source,sourceJwtSecret,body.input.device_id,row.pin_version);await client.query('COMMIT');res.json({...directorySession,pin_authenticated:true});
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
 }));
}
