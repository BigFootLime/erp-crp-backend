import {z} from 'zod';
import type {Express,Request,Response,RequestHandler} from 'express';
import type {Pool} from 'pg';
import * as admin from '../module/admin/services/admin.service';
import {adminCreateUserSchema,adminUpdateUserSchema,adminCreateInvitationSchema,adminCreatePasswordResetSchema,resetPasswordByAdminSchema,adminRecoverAccountSchema} from '../module/admin/validators/admin.validators';
import {recoverAccountBySuperadmin} from '../module/admin/services/account-recovery.service';
import {validateDirectorySession} from './session.repository';
import {directoryProfileForSite,bindProvisionedProfile} from './admin.repository';
import {requireDirectoryAdmin,requireDirectoryOwner,isDirectoryOwner} from './authority';
import {HttpError} from '../utils/httpError';
type Wrap=(work:(req:Request,res:Response)=>Promise<void>)=>RequestHandler;
const sourceSession=z.string().regex(/^dir_[a-f0-9]{64}$/);
export function mountDirectoryAdmin(app:Express,db:Pool,wrap:Wrap){
 const endpoint=(operation:string,work:(actor:Awaited<ReturnType<typeof validateDirectorySession>>,input:unknown)=>Promise<unknown>)=>app.post(`/internal/directory/${operation}`,wrap(async(req,res)=>{
  const body=z.object({directory_session:sourceSession,input:z.unknown()}).strict().parse(req.body);
  const actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);
  if(!actor.is_superadmin)throw new HttpError(403,'DIRECTORY_ADMIN_REQUIRED','Accès administrateur requis.');
  if(operation!=='admin-users'&&operation!=='admin-user')requireDirectoryAdmin(actor);
  res.json(await work(actor,body.input));
 }));
 const target=async(actor:Awaited<ReturnType<typeof validateDirectorySession>>,id:string)=>{
  const profile=await directoryProfileForSite(db,actor.database,z.string().uuid().parse(id));
  const owner=await isDirectoryOwner(db,actor);
  const protectedTarget=(await db.query("SELECT 1 FROM public.cerp_directory_memberships WHERE profile_id=$1::uuid AND database_id='cerp_prod'",[id])).rows.length>0;
  if(!owner&&protectedTarget&&actor.profile_id!==id)throw new HttpError(403,'DIRECTORY_OWNER_REQUIRED','Ce compte dispose d’un accès Production.');
  return profile;
 };
 const detail=async(actor:Awaited<ReturnType<typeof validateDirectorySession>>,id:string)=>{
  const profile=await target(actor,id),user=await admin.getUser(profile.source_user_id);if(!user)throw new HttpError(404,'USER_NOT_FOUND','Utilisateur inconnu.');
  return {profile,user:{...user,role:profile.role,roles:profile.roles,status:profile.status,is_superadmin:profile.is_superadmin}};
 };
 endpoint('admin-users',async(actor,input)=>{
  z.object({}).strict().parse(input);
  const users=await admin.listUsers(),ids=(await db.query('SELECT profile_id,user_id FROM public.cerp_directory_profiles')).rows;
  const mapped=[];for(const id of ids){const profile=await directoryProfileForSite(db,actor.database,id.profile_id),user=users.find(u=>u.id===id.user_id);if(user)mapped.push({profile,user:{...user,role:profile.role,roles:profile.roles,status:profile.status,is_superadmin:profile.is_superadmin}});}return mapped;
 });
 endpoint('admin-user',async(actor,input)=>detail(actor,z.object({profile_id:z.string().uuid()}).strict().parse(input).profile_id));
 endpoint('admin-user-create',async(actor,input)=>{
  const parsed=adminCreateUserSchema.parse(input);
  if(actor.database==='cerp_prod')await requireDirectoryOwner(db,actor);
  const {test_superadmin:_flag,...rawFields}=parsed.body;
  const fields={...rawFields,name:rawFields.name.toLocaleUpperCase('fr-FR'),surname:rawFields.surname.toLocaleUpperCase('fr-FR')};
  const result=await admin.createUserByAdmin({...fields,actorUserId:actor.source_user_id,idempotencyKey:parsed.headers.idempotencyKey});
  const profileId=await bindProvisionedProfile(db,result.user.id,actor.database,fields.work_profile?.weekly_hours_target);
  return {...await detail(actor,profileId),replayed:result.replayed};
 });
 endpoint('admin-user-update',async(actor,input)=>{
  const envelope=z.object({profile_id:z.string().uuid(),input:z.unknown()}).strict().parse(input);
  const body={profile_id:envelope.profile_id,input:adminUpdateUserSchema.parse({params:{id:'1'},body:envelope.input}).body};
  await requireDirectoryOwner(db,actor);const profile=await target(actor,body.profile_id);
  if(body.input.status&&body.input.status!=='Active'){
   const last=(await db.query("SELECT count(*)::int n FROM public.cerp_directory_memberships m JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id JOIN public.users u ON u.id=p.user_id WHERE m.database_id='cerp_prod' AND m.is_superadmin AND m.status='Active' AND u.status='Active' AND m.profile_id<>$1::uuid",[body.profile_id])).rows[0];
   if(profile.is_superadmin&&last.n===0)throw new HttpError(409,'LAST_DIRECTORY_OWNER','Conservez un administrateur Production actif.');
  }
  const {role,roles,...contactPatch}=body.input;
  if(typeof contactPatch.name==='string')contactPatch.name=contactPatch.name.toLocaleUpperCase('fr-FR');
  if(typeof contactPatch.surname==='string')contactPatch.surname=contactPatch.surname.toLocaleUpperCase('fr-FR');
  if(Object.keys(contactPatch).length)await admin.updateUserByAdmin(profile.source_user_id,contactPatch,actor.source_user_id);
  if(role||roles){
   const nextRole=role??roles![0];
   const nextRoles=roles??[nextRole];if(!nextRoles.includes(nextRole))throw new HttpError(400,'DIRECTORY_ROLE_INVALID','Le rôle principal doit figurer dans les rôles attribués.');
   await db.query(`INSERT INTO public.cerp_directory_memberships(profile_id,database_id,role_key,roles,status,is_superadmin) VALUES($1::uuid,$2,$3,$4::text[],'Active',false)
    ON CONFLICT(profile_id,database_id) DO UPDATE SET role_key=excluded.role_key,roles=excluded.roles,version=public.cerp_directory_memberships.version+1
    WHERE (public.cerp_directory_memberships.role_key,public.cerp_directory_memberships.roles) IS DISTINCT FROM (excluded.role_key,excluded.roles)`,[body.profile_id,actor.database,nextRole,nextRoles]);
  }
  return detail(actor,body.profile_id);
 });
 endpoint('admin-user-invite',async(actor,input)=>{
  const body=z.object({profile_id:z.string().uuid(),key:z.string().uuid()}).strict().parse(input),profile=await target(actor,body.profile_id);
  adminCreateInvitationSchema.parse({params:{id:String(profile.source_user_id)},headers:{idempotencyKey:body.key},body:{}});
  const result=await admin.createAccountInvitationByAdmin({userId:profile.source_user_id,actorUserId:actor.source_user_id,idempotencyKey:body.key});return {...result,profile_id:body.profile_id};
 });
 endpoint('admin-user-reset-token',async(actor,input)=>{
  const body=z.object({profile_id:z.string().uuid(),key:z.string().uuid()}).strict().parse(input);await requireDirectoryOwner(db,actor);const profile=await target(actor,body.profile_id);
  adminCreatePasswordResetSchema.parse({params:{id:String(profile.source_user_id)},headers:{idempotencyKey:body.key},body:{}});
  return {...await admin.createPasswordResetTokenByAdmin({userId:profile.source_user_id,actorUserId:actor.source_user_id,idempotencyKey:body.key}),profile_id:body.profile_id};
 });
 endpoint('admin-user-password',async(actor,input)=>{
  const body=z.object({profile_id:z.string().uuid(),input:resetPasswordByAdminSchema.shape.body}).strict().parse(input);await requireDirectoryOwner(db,actor);const profile=await target(actor,body.profile_id);
  await admin.resetUserPasswordByAdmin({userId:String(profile.source_user_id),actorUserId:actor.source_user_id,token:body.input.token,newPassword:body.input.newPassword});return {reset:true};
 });
 endpoint('admin-user-recover',async(actor,input)=>{
  const body=z.object({profile_id:z.string().uuid(),key:z.string().uuid(),input:adminRecoverAccountSchema.shape.body}).strict().parse(input);await requireDirectoryOwner(db,actor);const profile=await target(actor,body.profile_id);
  return {...await recoverAccountBySuperadmin({userId:profile.source_user_id,actorUserId:actor.source_user_id,actorSessionEpoch:actor.global_session_epoch,actorFactorId:actor.mfa_factor_id,actorFactorVersion:actor.mfa_factor_version,idempotencyKey:body.key,reason:body.input.reason,meta:{ip:null,user_agent:null,device_type:null,os:null,browser:null,path:'/directory/admin-user-recover'}}),profile_id:body.profile_id};
 });
}
