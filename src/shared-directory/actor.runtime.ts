import {z} from 'zod';
import type {Pool} from 'pg';
import {directoryProfileSchema} from './model';
import {sharedDirectoryClient,sharedDirectorySite,projectDirectoryProfile} from './site-runtime';
import {synchronizeCommonAccess} from './common-access';
import {bumpRealtimeSessionEpoch} from '../shared/realtime/realtime-control-plane';
import {HttpError} from '../utils/httpError';
const actorSchema=z.object({profile:directoryProfileSchema,global_session_epoch:z.number().int().nonnegative(),membership_version:z.number().int().nonnegative(),mfa_factor_id:z.string().guid().nullable(),mfa_factor_version:z.number().int().positive().nullable(),mfa_required:z.boolean()}).strict().refine(value=>(value.mfa_factor_id===null)===(value.mfa_factor_version===null),'Incomplete actor MFA factor');
/** Native PIN remains local. Its actor lifecycle and base permissions are common. */
export async function synchronizeDirectoryActor(db:Pool,userId:number){
 const directory=sharedDirectoryClient();if(!directory)return null;
 const mapping=(await db.query(`SELECT coalesce(u.directory_profile_id,b.profile_id) AS profile_id FROM public.users u
  LEFT JOIN public.cerp_directory_approved_actor_bindings b ON b.user_id=u.id WHERE u.id=$1`,[userId])).rows[0];
 if(!mapping?.profile_id)return null;
 let actor:z.infer<typeof actorSchema>;
 try{actor=actorSchema.parse(await directory.call('validate-actor-v2',{profile_id:mapping.profile_id}));}catch(error){
  const failure=error as {status?:number;code?:string};
  if([401,403].includes(failure.status??0)||(failure.status===404&&failure.code==='USER_NOT_FOUND'))return null;
  if(failure.status===404)throw new HttpError(503,'DIRECTORY_UNAVAILABLE','L’annuaire doit être mis à jour avant cette opération.');
  throw error;
 }
 const local=await projectDirectoryProfile(db,actor.profile);if(local.id!==userId)throw new Error('DIRECTORY_ACTOR_ID_CHANGED');
 const site=sharedDirectorySite();if(site&&actor.profile.status==='Active'&&!actor.profile.is_superadmin)await synchronizeCommonAccess(db,directory,site,actor.profile.profile_id);
 const tx=await db.connect();await tx.query('BEGIN');
 try{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`directory-actor:${actor.profile.profile_id}`]);
  const state=(await tx.query('SELECT global_session_epoch,membership_version FROM public.cerp_directory_actor_state WHERE profile_id=$1::uuid',[actor.profile.profile_id])).rows[0];
  if(state&&(Number(state.global_session_epoch)!==actor.global_session_epoch||state.membership_version!==actor.membership_version))await bumpRealtimeSessionEpoch(tx,userId);
  await tx.query(`INSERT INTO public.cerp_directory_actor_state(profile_id,user_id,global_session_epoch,membership_version) VALUES($1::uuid,$2,$3,$4)
   ON CONFLICT(profile_id) DO UPDATE SET global_session_epoch=excluded.global_session_epoch,membership_version=excluded.membership_version,updated_at=now()`,[actor.profile.profile_id,userId,actor.global_session_epoch,actor.membership_version]);
  const epoch=(await tx.query('SELECT coalesce((SELECT session_epoch FROM public.realtime_session_epochs WHERE user_id=$1),0)::text AS epoch',[userId])).rows[0].epoch;
  await tx.query('COMMIT');return {status:actor.profile.status,session_epoch:Number(epoch),is_superadmin:actor.profile.is_superadmin,mfa_required:actor.mfa_required,mfa_factor_id:actor.mfa_factor_id,mfa_factor_version:actor.mfa_factor_version,directory_global_epoch:actor.global_session_epoch,directory_membership_version:actor.membership_version,reenrollment_required:actor.profile.mfa_reenrollment_required};
 }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
