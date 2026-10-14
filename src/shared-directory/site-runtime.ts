import type {Pool} from 'pg';
import {randomBytes} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {DirectoryClient,LOCAL_DIRECTORY_ENDPOINT} from './client';
import {directoryIdSchema,directorySessionSchema,directoryProfileSchema,siteIdSchema,type DirectorySession,type DirectoryProfile} from './model';
import {issueSessionToken} from '../module/auth/domain/session-token';
import {insertLoginLog} from '../module/auth/repository/authLog.repository';
import {synchronizeDirectoryCompany} from './company.projection';
import {createEmployeeWorkProfile} from '../module/auth/repository/work-profile.repository';
let client:DirectoryClient|null=null;
let site:string|null=null;
let authorityId:string|null=null;
export function sharedDirectoryClient(){return client;}
export function sharedDirectorySite(){return site;}
export async function initializeSharedDirectorySite(db:Pool,env:NodeJS.ProcessEnv=process.env){
 if(env.CERP_SHARED_DIRECTORY_ENABLED!=='true'){
  const patched=(await db.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='directory_profile_id') AS ok")).rows[0]?.ok;
  if(patched&&(await db.query('SELECT 1 FROM public.users WHERE directory_profile_id IS NOT NULL LIMIT 1')).rows.length)throw new Error('DIRECTORY_ACTIVE_SITE_CANNOT_FALL_BACK_TO_LEGACY');
  client=null;site=null;authorityId=null;return;
 }
 const actual=(await db.query('SELECT current_database() AS database')).rows[0]?.database;
 siteIdSchema.parse(actual);
 if(actual!==env.CERP_SHARED_DIRECTORY_SITE)throw new Error('DIRECTORY_SITE_CONFIGURATION_MISMATCH');
 if(!(await db.query("SELECT to_regclass('public.cerp_directory_projection_state') IS NOT NULL AS ok")).rows[0]?.ok)throw new Error('DIRECTORY_SITE_PATCH_REQUIRED');
 const next=new DirectoryClient(env.CERP_DIRECTORY_ENDPOINT??LOCAL_DIRECTORY_ENDPOINT,actual,env.CERP_DIRECTORY_SITE_CALL_KEY??'');
 const info=await next.call<{directory_id:string;schema_version:number}>('info',{});
 if(info.directory_id!==directoryIdSchema.parse(env.CERP_SHARED_DIRECTORY_ID)||info.schema_version!==1)throw new Error('DIRECTORY_AUTHORITY_MISMATCH');
 client=next;site=actual;authorityId=info.directory_id;
}
/** Preserve legacy rows and foreign keys; a new identity gets a new local ID. */
export async function projectDirectoryIdentity(db:Pool,raw:DirectorySession){
 const identity=directorySessionSchema.parse(raw);
 return projectDirectoryProfile(db,identity,identity);
}
export async function projectDirectoryProfile(db:Pool,raw:DirectoryProfile,assurance?:DirectorySession){
 const identity=directoryProfileSchema.parse(Object.fromEntries(Object.keys(directoryProfileSchema.shape).map(key=>[key,raw[key as keyof DirectoryProfile]])));
 if(identity.database!==site)throw new Error('DIRECTORY_PROJECTION_SITE_MISMATCH');
 const tx=await db.connect();await tx.query('BEGIN');
 try{
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`directory-profile:${identity.profile_id}`]);
  let row=(await tx.query<{id:number}>('SELECT id FROM public.users WHERE directory_profile_id=$1::uuid',[identity.profile_id])).rows[0];
  if(!row){
   const approved=(await tx.query<{id:number;directory_id:string;expected_username:string;expected_email:string}>(`SELECT u.id,b.directory_id,b.expected_username,b.expected_email FROM public.cerp_directory_approved_actor_bindings b JOIN public.users u ON u.id=b.user_id
    WHERE b.profile_id=$1::uuid AND u.directory_profile_id IS NULL AND upper(u.username)=upper(b.expected_username) AND lower(u.email)=lower(b.expected_email) FOR UPDATE OF u`,[identity.profile_id])).rows[0];
   if(approved){
    if(approved.directory_id!==authorityId||approved.expected_username!==identity.username||approved.expected_email.toLowerCase()!==identity.email?.toLowerCase())throw new Error('DIRECTORY_APPROVED_ACTOR_MISMATCH');
    await tx.query('UPDATE public.users SET directory_profile_id=$2::uuid,password=$3,mfa_reenrollment_required=false WHERE id=$1',[approved.id,identity.profile_id,await bcrypt.hash(randomBytes(48).toString('hex'),12)]);row={id:approved.id};
   }
  }
  if(!row){
   const collision=(await tx.query('SELECT 1 FROM public.users WHERE upper(username)=upper($1)',[identity.username])).rows.length>0;
   const localUsername=collision?`DIR_${identity.profile_id.replace(/-/g,'')}`:identity.username;
   const emailCollision=identity.email&&(await tx.query('SELECT 1 FROM public.users WHERE lower(email)=lower($1)',[identity.email])).rows.length>0;
   const localEmail=emailCollision?`dir.${identity.profile_id.replace(/-/g,'')}@identity.cerp.invalid`:identity.email;
   // No credential is copied into a business database. Local password login is
   // unavailable for this projection; only a validated directory session works.
   const unusable=await bcrypt.hash(randomBytes(48).toString('hex'),12);
   row=(await tx.query<{id:number}>(`INSERT INTO public.users(username,directory_username,directory_email,directory_profile_id,password,name,surname,email,role,status,is_superadmin,mfa_reenrollment_required,avatar_key,country)
    VALUES($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$12,$10,false,$11,'France') RETURNING id`,[localUsername,identity.username,identity.email,identity.profile_id,unusable,identity.name,identity.surname,localEmail,identity.role,identity.is_superadmin,identity.avatar_key,identity.status])).rows[0];
  }else{
   await tx.query(`UPDATE public.users SET directory_username=$2,name=$3,surname=$4,directory_email=$5,role=$6,status=$10,is_superadmin=$7,avatar_key=$8 WHERE id=$1 AND directory_profile_id=$9::uuid
    AND (directory_username,name,surname,directory_email,role,is_superadmin,avatar_key,status) IS DISTINCT FROM ($2,$3,$4,$5,$6,$7,$8,$10)`,[row.id,identity.username,identity.name,identity.surname,identity.email,identity.role,identity.is_superadmin,identity.avatar_key,identity.profile_id,identity.status]);
  }
  await tx.query('UPDATE public.users SET directory_avatar_asset_id=$2::uuid WHERE id=$1 AND directory_avatar_asset_id IS DISTINCT FROM $2::uuid',[row.id,identity.avatar_asset_id]);
  await tx.query('UPDATE public.users SET mfa_reenrollment_required=$2 WHERE id=$1 AND mfa_reenrollment_required IS DISTINCT FROM $2',[row.id,identity.mfa_reenrollment_required]);
  const metadata={job_title:identity.job_title,employment_type:identity.employment_type,weekly_hours_target:identity.weekly_hours_target,work_profile_incomplete:identity.work_profile_incomplete};
  await tx.query('UPDATE public.users SET directory_profile_metadata=$2::jsonb WHERE id=$1 AND directory_profile_metadata IS DISTINCT FROM $2::jsonb',[row.id,JSON.stringify(metadata)]);
  if(identity.work_profile&&!(await tx.query('SELECT 1 FROM public.cerp_directory_work_profile_bindings WHERE profile_id=$1::uuid',[identity.profile_id])).rows.length){
   // Existing employment history stays intact, including the approved owner actor.
   if(!(await tx.query('SELECT 1 FROM public.hr_employees WHERE user_id=$1',[row.id])).rows.length)await createEmployeeWorkProfile(tx,row.id,identity.work_profile,`DIR-${identity.profile_id.replace(/-/g,'')}`,identity.work_profile_start_date??undefined);
   await tx.query('INSERT INTO public.cerp_directory_work_profile_bindings(profile_id,user_id) VALUES($1::uuid,$2)',[identity.profile_id,row.id]);
  }
  const roles=(await tx.query<{role_key:string}>('SELECT role_key FROM public.user_role_assignments WHERE user_id=$1 ORDER BY role_key',[row.id])).rows.map(r=>r.role_key);
  if(JSON.stringify(roles)!==JSON.stringify([...identity.roles].sort())){
   await tx.query('DELETE FROM public.user_role_assignments WHERE user_id=$1',[row.id]);
   for(const role of identity.roles)await tx.query('INSERT INTO public.user_role_assignments(user_id,role_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[row.id,role]);
  }
  if(assurance)await tx.query(`INSERT INTO public.cerp_directory_projection_state(profile_id,user_id,source_user_id,global_session_epoch,membership_version,mfa_factor_id,mfa_factor_version)
   VALUES($1::uuid,$2,$3,$4,$5,$6::uuid,$7) ON CONFLICT(profile_id) DO UPDATE SET global_session_epoch=excluded.global_session_epoch,membership_version=excluded.membership_version,mfa_factor_id=excluded.mfa_factor_id,mfa_factor_version=excluded.mfa_factor_version,updated_at=now()`,[identity.profile_id,row.id,identity.source_user_id,assurance.global_session_epoch,assurance.membership_version,assurance.mfa_factor_id,assurance.mfa_factor_version]);
  const epoch=(await tx.query("SELECT coalesce((SELECT session_epoch FROM public.realtime_session_epochs WHERE user_id=$1),0)::text AS epoch",[row.id])).rows[0].epoch;
  await tx.query('COMMIT');return {id:row.id,session_epoch:Number(epoch)};
 }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
export async function directoryAuthenticationResult(db:Pool,result:unknown,meta?:{ip:string|null;user_agent:string|null;device_type:string|null;os:string|null;browser:string|null}):Promise<Record<string,unknown>>{
 const value=result as {directory_session?:string;identity?:DirectorySession;recovery_codes?:string[]};
 if(!value.directory_session){
  const challenge=result as {status?:string;challenge_token?:string;token?:string};
  if(challenge.token||!['mfa_required','mfa_enrollment_required','mfa_replacement_pending'].includes(challenge.status??'')||typeof challenge.challenge_token!=='string')throw new Error('DIRECTORY_AUTH_RESPONSE_INVALID');
  return result as Record<string,unknown>;
 }
 const identity=directorySessionSchema.parse(value.identity),projection=await projectDirectoryIdentity(db,identity);
 if(meta)await insertLoginLog({user_id:projection.id,username_attempt:identity.username,success:true,...meta});
 return {...issueSessionToken({id:projection.id,username:identity.username,email:identity.email,role:identity.role,roles:identity.roles,avatar_key:identity.avatar_key,profile_picture_asset_id:identity.avatar_asset_id,realtime_session_epoch:projection.session_epoch},{factorId:identity.mfa_factor_id,factorVersion:identity.mfa_factor_version,verifiedAt:new Date(identity.mfa_verified_at),method:identity.mfa_method}, {session:value.directory_session,profileId:identity.profile_id,membershipVersion:identity.membership_version,globalEpoch:identity.global_session_epoch}),...(value.recovery_codes?{recovery_codes:value.recovery_codes}:{})};
}
export async function validateSiteDirectoryToken(db:Pool,claims:{id:number;directory_session?:string;directory_profile_id?:string;directory_global_epoch?:number;directory_membership_version?:number;mfa_factor_id?:string;mfa_factor_version?:number;session_epoch?:number}){
 if(!client||!claims.directory_session)throw new Error('DIRECTORY_SESSION_REQUIRED');
 const identity=await client.validate(claims.directory_session);
 if(identity.profile_id!==claims.directory_profile_id||identity.global_session_epoch!==claims.directory_global_epoch||identity.membership_version!==claims.directory_membership_version||identity.mfa_factor_id!==claims.mfa_factor_id||identity.mfa_factor_version!==claims.mfa_factor_version)throw new Error('DIRECTORY_SESSION_STALE');
 const projection=await projectDirectoryIdentity(db,identity);
 if(projection.id!==claims.id||projection.session_epoch!==claims.session_epoch)throw new Error('DIRECTORY_LOCAL_SESSION_STALE');
 await synchronizeDirectoryCompany(db,claims.directory_session);
 return identity;
}
