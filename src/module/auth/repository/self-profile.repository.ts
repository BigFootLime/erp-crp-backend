import type {PoolClient} from 'pg';
import pool from '../../../config/database';
import {HttpError} from '../../../utils/httpError';
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {repoInsertAuditLog} from '../../audit-logs/repository/audit-logs.repository';
import {readUserAvatar} from './avatar.repository';
import type {SelfProfilePatch} from '../validators/self-profile.validator';
import type {MfaAuditMeta} from '../services/mfa.service';

export async function readSelfProfile(userId:number,q:Pick<PoolClient,'query'>=pool){
 const row=(await q.query(`SELECT u.id,coalesce(to_jsonb(u)->>'directory_username',u.username) AS username,u.name,u.surname,
  coalesce(to_jsonb(u)->>'directory_email',u.email) AS email,u.tel_no,
  to_jsonb(u)->'directory_profile_metadata'->>'job_title' AS job_title,
  to_jsonb(u)->'directory_profile_metadata'->>'employment_type' AS employment_type,
  (to_jsonb(u)->'directory_profile_metadata'->>'weekly_hours_target')::float AS weekly_hours_target
  FROM public.users u WHERE u.id=$1 AND u.status='Active'`,[userId])).rows[0];
 if(!row)throw new HttpError(403,'PROFILE_UNAVAILABLE','Ce profil n’est plus disponible.');
 const avatar=await readUserAvatar(userId,q);
 return {...row,...avatar};
}

/** The actor comes exclusively from the validated session; administrative fields never enter this query. */
export async function updateSelfProfile(userId:number,patch:SelfProfilePatch,meta:MfaAuditMeta){
 const client=await pool.connect();
 try{
  await withRealtimeOutboxTransaction(client,async tx=>{
   const current=(await tx.query('SELECT name,surname,email,tel_no,avatar_key,profile_picture,status FROM public.users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
   if(!current||current.status!=='Active')throw new HttpError(403,'PROFILE_UNAVAILABLE','Ce profil n’est plus disponible.');
   if(patch.email!==undefined&&(await tx.query('SELECT 1 FROM public.users WHERE lower(email)=lower($1) AND id<>$2',[patch.email,userId])).rows.length)throw new HttpError(409,'PROFILE_EMAIL_IN_USE','Cette adresse email est déjà utilisée.');
   const columns=['name','surname','email','tel_no','avatar_key'] as const;
   const changed=columns.filter(k=>patch[k]!==undefined&&(patch[k]!==current[k]||(k==='avatar_key'&&current.profile_picture!==null)));
   if(!changed.length)return;
   const args:unknown[]=changed.map(k=>patch[k]);args.push(userId);
   await tx.query(`UPDATE public.users SET ${changed.map((k,i)=>`${k}=$${i+1}`).join(',')}${patch.avatar_key!==undefined?',profile_picture=NULL':''} WHERE id=$${args.length}`,args);
   await repoInsertAuditLog({user_id:userId,body:{event_type:'ACTION',action:'AUTH_SELF_PROFILE_UPDATED',page_key:'erp-settings',entity_type:'user',entity_id:String(userId),path:meta.path,details:{fields:changed}},...meta,tx});
  });
 }catch(error){
  if((error as {code?:string}).code==='23505')throw new HttpError(409,'PROFILE_EMAIL_IN_USE','Cette adresse email est déjà utilisée.');
  throw error;
 }
 return readSelfProfile(userId);
}
