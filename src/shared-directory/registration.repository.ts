import {createHmac,randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import type {Pool} from 'pg';
import {testRegistrationSchema} from '../module/auth/validators/test-registration.validator';
import {createEmployeeWorkProfile} from '../module/auth/repository/work-profile.repository';
import {ensureTestMembership} from './session.repository';
import {siteIdSchema} from './model';
export async function registerSharedTestProfile(db:Pool,site:string,raw:unknown,key:string,hashKey:string){
 siteIdSchema.parse(site);if(site==='cerp_prod')throw new Error('DIRECTORY_PRODUCTION_REGISTRATION_DISABLED');
 const input=testRegistrationSchema.parse(raw),requestHash=createHmac('sha256',hashKey).update(JSON.stringify({site,input})).digest('hex');
 const tx=await db.connect();await tx.query('BEGIN');
 try{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`directory-registration:${key}`]);
  const previous=(await tx.query('SELECT user_id,request_hash FROM public.test_account_registrations WHERE idempotency_key=$1::uuid',[key])).rows[0];
  if(previous){if(previous.request_hash!==requestHash)throw new Error('DIRECTORY_REGISTRATION_KEY_REUSED');await tx.query('COMMIT');return {source_user_id:previous.user_id,replayed:true};}
  const user=(await tx.query<{id:number}>(`INSERT INTO public.users(username,password,name,surname,email,role,status,is_superadmin,mfa_reenrollment_required,avatar_key,country)
   VALUES($1,$2,$3,$4,$5,'Administrateur Systeme et Reseau','Active',true,true,$6,'France') RETURNING id`,[input.username,await bcrypt.hash(input.password,12),input.name,input.surname,input.email,input.avatar_key])).rows[0];
  await tx.query("INSERT INTO public.user_role_assignments(user_id,role_key) VALUES($1,'Administrateur Systeme et Reseau')",[user.id]);
  await tx.query('INSERT INTO public.cerp_directory_profiles(profile_id,user_id,weekly_hours_target,work_profile_incomplete) VALUES($1::uuid,$2,$3,false)',[randomUUID(),user.id,input.weekly_hours_target]);
  await createEmployeeWorkProfile(tx,user.id,input,`DIR-${user.id}`);
  await ensureTestMembership(tx,site,user.id);
  await tx.query('INSERT INTO public.test_account_registrations(idempotency_key,request_hash,user_id) VALUES($1::uuid,$2,$3)',[key,requestHash,user.id]);
  await tx.query('COMMIT');return {source_user_id:user.id,replayed:false};
 }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
