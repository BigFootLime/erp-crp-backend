import bcrypt from 'bcryptjs';
import {z} from 'zod';
import type {Express,RequestHandler} from 'express';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {randomBytes,createHash} from 'node:crypto';
import {validateDirectorySession,createDirectorySession} from './session.repository';
import {directoryAuthMetaSchema} from './mfa.operations';
import {directoryProfileForSite} from './admin.repository';
import {accountRequiresMfa,normalizeMfaPolicy} from '../module/auth/domain/mfa-policy';
import {issueSessionToken} from '../module/auth/domain/session-token';
import {beginMfaAfterPassword} from '../module/auth/services/mfa.service';
import {bindChallenge} from './session.repository';

const session=z.string().regex(/^dir_[a-f0-9]{64}$/);
const pin=z.string().regex(/^\d{4}$/);
const deviceId=z.string().uuid(); const deviceSecret=z.string().regex(/^[a-f0-9]{64}$/);
const secretHash=(value:string)=>createHash('sha256').update(value).digest('hex');
const envelope=z.object({directory_session:session,meta:directoryAuthMetaSchema}).strict();
const PIN_LOCK_ATTEMPTS=5;
const PIN_LOCK_MINUTES=15;
/** Tablet PIN authentication is deliberately independent of terminal PINs. */
export function mountDirectoryTabletPins(app:Express,db:Pool,sourceJwtSecret:string,wrap:(work:any)=>RequestHandler){
 const requireAdmin=async(actor:any,site:string)=>{const allowed=(await db.query('SELECT 1 FROM public.cerp_directory_memberships WHERE profile_id=$1::uuid AND database_id=$2 AND status=\'Active\' AND is_superadmin=true',[actor.profile_id,site])).rows.length>0;if(!allowed)throw Object.assign(new Error('DIRECTORY_ADMIN_REQUIRED'),{status:403,code:'DIRECTORY_ADMIN_REQUIRED'});};
 app.post('/internal/directory/tablet-pin-status',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);
  const rows=(await db.query(`SELECT device_id::text,label,created_at::text,last_used_at::text FROM public.cerp_directory_tablet_devices WHERE profile_id=$1::uuid AND revoked_at IS NULL ORDER BY created_at`,[actor.profile_id])).rows;
  const configured=(await db.query('SELECT 1 FROM public.cerp_directory_tablet_pins WHERE profile_id=$1::uuid',[actor.profile_id])).rows.length>0;
  res.json({configured,devices:rows});
 }));
 app.post('/internal/directory/tablet-pin-set',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({pin,device_id:deviceId.optional(),device_label:z.string().trim().min(1).max(80)}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);
  const hash=await bcrypt.hash(body.input.pin,12); const id=body.input.device_id??randomUUID(); const rawDeviceSecret=randomBytes(32).toString('hex');
  await db.query('BEGIN'); try {
   await db.query(`INSERT INTO public.cerp_directory_tablet_pins(profile_id,pin_hash,version) VALUES($1::uuid,$2,1) ON CONFLICT(profile_id) DO UPDATE SET pin_hash=excluded.pin_hash,version=public.cerp_directory_tablet_pins.version+1,changed_at=now()`,[actor.profile_id,hash]);
   await db.query(`INSERT INTO public.cerp_directory_tablet_devices(device_id,profile_id,label,device_secret_hash) VALUES($1::uuid,$2::uuid,$3,$4) ON CONFLICT(device_id) DO UPDATE SET label=excluded.label,device_secret_hash=excluded.device_secret_hash,revoked_at=NULL,failed_attempts=0,locked_until=NULL`,[id,actor.profile_id,body.input.device_label,secretHash(rawDeviceSecret)]);
   await db.query('COMMIT'); res.json({device_id:id,device_secret:rawDeviceSecret,configured:true});
  }catch(e){await db.query('ROLLBACK');throw e;}
 }));
 app.post('/internal/directory/tablet-pin-revoke-device',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({device_id:deviceId}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);
  await db.query('UPDATE public.cerp_directory_tablet_devices SET revoked_at=now() WHERE device_id=$1::uuid AND profile_id=$2::uuid AND revoked_at IS NULL',[body.input.device_id,actor.profile_id]);res.status(204).end();
 }));
 app.post('/internal/directory/tablet-pin-revoke',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);
  await db.query('DELETE FROM public.cerp_directory_tablet_pins WHERE profile_id=$1::uuid',[actor.profile_id]);await db.query('UPDATE public.cerp_directory_tablet_devices SET revoked_at=now() WHERE profile_id=$1::uuid AND revoked_at IS NULL',[actor.profile_id]);res.status(204).end();
 }));
 app.post('/internal/directory/tablet-pin-admin-list',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);await requireAdmin(actor,req.directoryCaller!);
  const devices=(await db.query(`SELECT d.device_id::text,d.label,d.profile_id::text,p.user_id,u.username,d.created_at::text,d.last_used_at::text,d.revoked_at::text FROM public.cerp_directory_tablet_devices d JOIN public.cerp_directory_profiles p ON p.profile_id=d.profile_id JOIN public.users u ON u.id=p.user_id JOIN public.cerp_directory_memberships m ON m.profile_id=d.profile_id AND m.database_id=$1 AND m.status='Active' ORDER BY d.created_at DESC`,[req.directoryCaller!])).rows;res.json({devices});
 }));
 app.post('/internal/directory/tablet-pin-admin-revoke',wrap(async(req:any,res:any)=>{
  const body=envelope.extend({input:z.object({device_id:deviceId}).strict()}).parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);await requireAdmin(actor,req.directoryCaller!);await db.query(`UPDATE public.cerp_directory_tablet_devices d SET revoked_at=now() FROM public.cerp_directory_memberships m WHERE d.device_id=$1::uuid AND d.profile_id=m.profile_id AND m.database_id=$2 AND m.status='Active' AND d.revoked_at IS NULL`,[body.input.device_id,req.directoryCaller!]);res.status(204).end();
 }));
 app.post('/internal/directory/tablet-pin-login',wrap(async(req:any,res:any)=>{
  const body=z.object({input:z.object({device_id:deviceId,device_secret:deviceSecret,pin}).strict(),meta:directoryAuthMetaSchema}).strict().parse(req.body),site=req.directoryCaller!;
  const client=await db.connect();try{await client.query('BEGIN');const row=(await client.query<any>(`SELECT d.profile_id,d.failed_attempts,d.locked_until,d.revoked_at,d.device_secret_hash,(d.locked_until IS NOT NULL AND d.locked_until>now()) AS is_locked,p.pin_hash,u.id,u.password,u.mfa_required,u.is_superadmin,u.mfa_reenrollment_required,u.role,m.is_superadmin AS member_superadmin,m.status,coalesce(e.session_epoch,0) AS session_epoch,
   (SELECT value_text FROM public.erp_settings WHERE key='security.mfa_policy') AS mfa_policy,EXISTS(SELECT 1 FROM public.user_mfa_factors f WHERE f.user_id=u.id AND f.state='ACTIVE') AS has_factor
   FROM public.cerp_directory_tablet_devices d LEFT JOIN public.cerp_directory_tablet_pins p ON p.profile_id=d.profile_id JOIN public.cerp_directory_profiles dp ON dp.profile_id=d.profile_id JOIN public.users u ON u.id=dp.user_id JOIN public.cerp_directory_memberships m ON m.profile_id=d.profile_id AND m.database_id=$2 LEFT JOIN public.realtime_session_epochs e ON e.user_id=u.id WHERE d.device_id=$1::uuid FOR UPDATE`,[body.input.device_id,site])).rows[0];
   const valid=!!row&&!row.revoked_at&&row.status==='Active'&&!row.mfa_reenrollment_required&&!row.is_locked&&row.device_secret_hash===secretHash(body.input.device_secret)&&typeof row.pin_hash==='string'?await bcrypt.compare(body.input.pin,row.pin_hash):false;
   if(!valid){if(row&&!row.revoked_at){const attempts=Number(row.failed_attempts)+1;await client.query('UPDATE public.cerp_directory_tablet_devices SET failed_attempts=$2,locked_until=CASE WHEN $2>=$3 THEN now()+$4::int*interval \'1 minute\' ELSE locked_until END WHERE device_id=$1::uuid',[body.input.device_id,attempts,PIN_LOCK_ATTEMPTS,PIN_LOCK_MINUTES]);}await client.query('COMMIT');res.status(401).json({code:'AUTH_INVALID',message:'Identifiants invalides'});return;}
   const required=accountRequiresMfa({policy:normalizeMfaPolicy(row.mfa_policy),isSuperadmin:row.is_superadmin||row.member_superadmin,role:row.role,roles:[row.role],hasActiveFactor:row.has_factor,mfaRequired:row.mfa_required});
   if(required){await client.query('COMMIT');const challenge=await beginMfaAfterPassword({id:row.id,password:row.password} as any,{...body.meta,path:`/directory/${site}/auth/tablet-pin`});if(!challenge)throw new Error('DIRECTORY_MFA_REQUIRED');await bindChallenge(db,site,challenge.challenge_token);res.json(challenge);return;}
   await client.query('UPDATE public.cerp_directory_tablet_devices SET failed_attempts=0,locked_until=NULL,last_used_at=now() WHERE device_id=$1::uuid',[body.input.device_id]);await client.query('COMMIT');
   // Pin is an allowed primary factor only for accounts whose normal policy permits it.
   const source=issueSessionToken({id:row.id,username:'tablet-pin',email:null,role:row.role,realtime_session_epoch:row.session_epoch}).token;
   res.json({...await createDirectorySession(db,site,source,sourceJwtSecret),pin_authenticated:true});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }));
}
