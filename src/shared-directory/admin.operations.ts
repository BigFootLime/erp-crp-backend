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
import {repoInsertAuditLog} from '../module/audit-logs/repository/audit-logs.repository';
import type {DirectorySession} from './model';
type Wrap=(work:(req:Request,res:Response)=>Promise<void>)=>RequestHandler;
const sourceSession=z.string().regex(/^dir_[a-f0-9]{64}$/);
const productionSuperadminMutationSchema=z.object({profile_id:z.string().guid(),is_superadmin:z.boolean(),expected_version:z.number().int().nonnegative()}).strict();
type ProductionSuperadminMutation=z.infer<typeof productionSuperadminMutationSchema>;

export async function assertDirectoryStatusMutationAllowed(db:Pool,profileId:string,nextStatus:string|undefined){
 if(nextStatus===undefined||nextStatus==='Active')return;
 const installed=(await db.query<{installed:boolean}>("SELECT to_regclass('public.cerp_directory_memberships') IS NOT NULL AS installed")).rows[0]?.installed===true;
 if(!installed)throw new HttpError(503,'DIRECTORY_AUTHORITY_REQUIRED','L’autorité annuaire est indisponible.');
 const owner=(await db.query(`SELECT 1 FROM public.cerp_directory_memberships m
  WHERE m.profile_id=$1::uuid AND m.database_id='cerp_prod' AND m.status='Active' AND m.is_superadmin`,[profileId])).rows.length>0;
 if(owner)throw new HttpError(409,'DIRECTORY_OWNER_STATUS_MANAGED','La désactivation d’un propriétaire Production exige le parcours sécurisé dédié.');
}

/**
 * The shared directory is the only authority for Production superAdmin state.
 * Membership versions make every previously issued directory session stale.
 */
export async function setProductionSuperadminMembership(db:Pool,actor:DirectorySession,input:ProductionSuperadminMutation){
 if(actor.database!=='cerp_prod')throw new HttpError(403,'DIRECTORY_PRODUCTION_CONTEXT_REQUIRED','Cette opération doit être réalisée depuis Production.');
 requireDirectoryAdmin(actor);
 const tx=await db.connect();
 try{
  await tx.query('BEGIN');
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('directory-production-superadmin',0))");
  const target=(await tx.query<{profile_id:string;user_id:number;is_superadmin:boolean;version:number;status:string;user_status:string;mfa_reenrollment_required:boolean}>(`SELECT m.profile_id,p.user_id,m.is_superadmin,m.version,m.status,u.status AS user_status,u.mfa_reenrollment_required
   FROM public.cerp_directory_memberships m JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id JOIN public.users u ON u.id=p.user_id
   WHERE m.profile_id=$1::uuid AND m.database_id='cerp_prod' FOR UPDATE OF m,u`,[input.profile_id])).rows[0];
  if(!target)throw new HttpError(404,'DIRECTORY_PROFILE_NOT_FOUND','Profil annuaire inconnu.');
  const owners=(await tx.query<{profile_id:string;user_id:number}>(`SELECT m.profile_id,p.user_id
   FROM public.cerp_directory_memberships m JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id JOIN public.users u ON u.id=p.user_id
   WHERE m.database_id='cerp_prod' AND m.is_superadmin AND m.status='Active' AND u.status='Active' FOR UPDATE OF m,u`)).rows;
  const lockedUserIds=[...new Set([target.user_id,...owners.map(owner=>owner.user_id)])];
  await tx.query('SELECT id FROM public.user_mfa_factors WHERE user_id=ANY($1::int[]) FOR UPDATE',[lockedUserIds]);
  // The initial step-up check can become stale while this request waits on the global owner lock.
  requireDirectoryAdmin(actor);
  if(!owners.some(owner=>owner.profile_id===actor.profile_id))throw new HttpError(403,'DIRECTORY_OWNER_REQUIRED','Cette modification commune exige un administrateur de Production.');
  const actorStillAssured=(await tx.query(`SELECT 1 FROM public.cerp_directory_memberships m
   JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id JOIN public.users u ON u.id=p.user_id
   JOIN public.user_mfa_factors f ON f.user_id=u.id LEFT JOIN public.realtime_session_epochs e ON e.user_id=u.id
   WHERE m.profile_id=$1::uuid AND m.database_id='cerp_prod' AND m.status='Active' AND m.is_superadmin AND m.version=$2
   AND u.status='Active' AND NOT u.mfa_reenrollment_required AND f.id=$3::uuid AND f.version=$4 AND f.state='ACTIVE'
   AND coalesce(e.session_epoch,0)=$5`,[actor.profile_id,actor.membership_version,actor.mfa_factor_id,actor.mfa_factor_version,actor.global_session_epoch])).rows.length>0;
  if(!actorStillAssured)throw new HttpError(403,'DIRECTORY_OWNER_REAUTH_REQUIRED','Votre autorisation a changé ; reconnectez-vous puis recommencez.');
  if(input.profile_id===actor.profile_id&&!input.is_superadmin)throw new HttpError(409,'DIRECTORY_SELF_DEMOTION_FORBIDDEN','Un propriétaire Production ne peut pas retirer son propre accès superAdmin.');
  if(target.version!==input.expected_version)throw new HttpError(409,'DIRECTORY_MEMBERSHIP_STALE','Les droits de ce compte viennent de changer ; actualisez avant de réessayer.');
  if(target.is_superadmin===input.is_superadmin){await tx.query('COMMIT');return {profile_id:target.profile_id,is_superadmin:target.is_superadmin,version:target.version,changed:false};}
  if(input.is_superadmin){
   const eligible=(await tx.query(`SELECT 1 FROM public.user_mfa_factors WHERE user_id=$1 AND state='ACTIVE'`,[target.user_id])).rows.length>0;
   if(target.status!=='Active'||target.user_status!=='Active'||target.mfa_reenrollment_required||!eligible)throw new HttpError(409,'DIRECTORY_OWNER_MFA_REQUIRED','Le compte cible doit être actif et disposer d’un facteur MFA actif.');
  }
  const updated=(await tx.query<{profile_id:string;is_superadmin:boolean;version:number}>(`UPDATE public.cerp_directory_memberships SET is_superadmin=$2,version=version+1
   WHERE profile_id=$1::uuid AND database_id='cerp_prod' AND version=$3 RETURNING profile_id,is_superadmin,version`,[input.profile_id,input.is_superadmin,input.expected_version])).rows[0];
  if(!updated)throw new HttpError(409,'DIRECTORY_MEMBERSHIP_STALE','Les droits de ce compte viennent de changer ; actualisez avant de réessayer.');
  const viable=(await tx.query<{n:number}>(`SELECT count(*)::int AS n FROM public.cerp_directory_memberships m
   JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id JOIN public.users u ON u.id=p.user_id
   WHERE m.database_id='cerp_prod' AND m.is_superadmin AND m.status='Active' AND u.status='Active' AND NOT u.mfa_reenrollment_required
   AND EXISTS(SELECT 1 FROM public.user_mfa_factors f WHERE f.user_id=u.id AND f.state='ACTIVE')`)).rows[0]?.n??0;
  if(viable<1)throw new HttpError(409,'LAST_DIRECTORY_OWNER','Conservez un administrateur Production actif avec MFA.');
  await repoInsertAuditLog({tx,user_id:actor.source_user_id,ip:null,user_agent:null,device_type:null,os:null,browser:null,body:{event_type:'ACTION',action:'DIRECTORY_SUPERADMIN_CHANGED',page_key:'administration-acces',entity_type:'directory_membership',entity_id:updated.profile_id,path:'/internal/directory/admin-user-superadmin',details:{database:'cerp_prod',previous_is_superadmin:target.is_superadmin,next_is_superadmin:updated.is_superadmin,membership_version:updated.version}}});
  await tx.query('COMMIT');
  return {...updated,changed:true};
 }catch(error){try{await tx.query('ROLLBACK');}catch{}throw error;}finally{tx.release();}
}
export function mountDirectoryAdmin(app:Express,db:Pool,wrap:Wrap){
 const endpoint=(operation:string,work:(actor:Awaited<ReturnType<typeof validateDirectorySession>>,input:unknown)=>Promise<unknown>)=>app.post(`/internal/directory/${operation}`,wrap(async(req,res)=>{
  const body=z.object({directory_session:sourceSession,input:z.unknown()}).strict().parse(req.body);
  const actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);
  if(!actor.is_superadmin)throw new HttpError(403,'DIRECTORY_ADMIN_REQUIRED','Accès administrateur requis.');
  if(operation!=='admin-users'&&operation!=='admin-user')requireDirectoryAdmin(actor);
  res.json(await work(actor,body.input));
 }));
 const target=async(actor:Awaited<ReturnType<typeof validateDirectorySession>>,id:string)=>{
  const profile=await directoryProfileForSite(db,actor.database,z.string().guid().parse(id));
  const owner=await isDirectoryOwner(db,actor);
  const protectedTarget=(await db.query("SELECT 1 FROM public.cerp_directory_memberships WHERE profile_id=$1::uuid AND database_id='cerp_prod'",[id])).rows.length>0;
  if(!owner&&protectedTarget&&actor.profile_id!==id)throw new HttpError(403,'DIRECTORY_OWNER_REQUIRED','Ce compte dispose d’un accès Production.');
  return profile;
 };
 const detail=async(actor:Awaited<ReturnType<typeof validateDirectorySession>>,id:string)=>{
  const profile=await target(actor,id),user=await admin.getUser(profile.source_user_id);if(!user)throw new HttpError(404,'USER_NOT_FOUND','Utilisateur inconnu.');
  const membership=(await db.query<{version:number}>('SELECT version FROM public.cerp_directory_memberships WHERE profile_id=$1::uuid AND database_id=$2',[id,actor.database])).rows[0];
  return {profile,membership_version:membership?.version??0,user:{...user,role:profile.role,roles:profile.roles,status:profile.status,is_superadmin:profile.is_superadmin}};
 };
 endpoint('admin-users',async(actor,input)=>{
  z.object({}).strict().parse(input);
  const users=await admin.listUsers(),ids=(await db.query('SELECT profile_id,user_id FROM public.cerp_directory_profiles')).rows;
  const mapped=[];for(const id of ids){const profile=await directoryProfileForSite(db,actor.database,id.profile_id),user=users.find(u=>u.id===id.user_id);if(user)mapped.push({profile,user:{...user,role:profile.role,roles:profile.roles,status:profile.status,is_superadmin:profile.is_superadmin}});}return mapped;
 });
 endpoint('admin-user',async(actor,input)=>detail(actor,z.object({profile_id:z.string().guid()}).strict().parse(input).profile_id));
 endpoint('admin-user-superadmin',async(actor,input)=>{
  const body=productionSuperadminMutationSchema.parse(input);
  await requireDirectoryOwner(db,actor);
  return setProductionSuperadminMembership(db,actor,body);
 });
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
  const envelope=z.object({profile_id:z.string().guid(),input:z.unknown()}).strict().parse(input);
  const body={profile_id:envelope.profile_id,input:adminUpdateUserSchema.parse({params:{id:'1'},body:envelope.input}).body};
  await requireDirectoryOwner(db,actor);const profile=await target(actor,body.profile_id);
  await assertDirectoryStatusMutationAllowed(db,body.profile_id,body.input.status);
  const {role,roles,...contactPatch}=body.input;
  if(typeof contactPatch.name==='string')contactPatch.name=contactPatch.name.toLocaleUpperCase('fr-FR');
  if(typeof contactPatch.surname==='string')contactPatch.surname=contactPatch.surname.toLocaleUpperCase('fr-FR');
  if(Object.keys(contactPatch).length)await admin.updateUserByAdmin(profile.source_user_id,contactPatch,actor.source_user_id);
  if(role||roles){
   const nextRole=role??roles![0];
   const nextRoles=roles??[nextRole];if(!nextRoles.includes(nextRole))throw new HttpError(400,'DIRECTORY_ROLE_INVALID','Le rôle principal doit figurer dans les rôles attribués.');
   // Production membership owns the functions of a common account, even when
   // its Production owner edits the profile from a Test context.
   const common=actor.database!=='cerp_prod'&&(await db.query("SELECT 1 FROM public.cerp_directory_memberships WHERE profile_id=$1::uuid AND database_id='cerp_prod'",[body.profile_id])).rows.length>0;
   const roleSite=common?'cerp_prod':actor.database;
   await db.query(`INSERT INTO public.cerp_directory_memberships(profile_id,database_id,role_key,roles,status,is_superadmin) VALUES($1::uuid,$2,$3,$4::text[],'Active',false)
    ON CONFLICT(profile_id,database_id) DO UPDATE SET role_key=excluded.role_key,roles=excluded.roles,version=public.cerp_directory_memberships.version+1
    WHERE (public.cerp_directory_memberships.role_key,public.cerp_directory_memberships.roles) IS DISTINCT FROM (excluded.role_key,excluded.roles)`,[body.profile_id,roleSite,nextRole,nextRoles]);
  }
  return detail(actor,body.profile_id);
 });
 endpoint('admin-user-invite',async(actor,input)=>{
  const body=z.object({profile_id:z.string().guid(),key:z.string().guid()}).strict().parse(input),profile=await target(actor,body.profile_id);
  adminCreateInvitationSchema.parse({params:{id:String(profile.source_user_id)},headers:{idempotencyKey:body.key},body:{}});
  const result=await admin.createAccountInvitationByAdmin({userId:profile.source_user_id,actorUserId:actor.source_user_id,idempotencyKey:body.key});return {...result,profile_id:body.profile_id};
 });
 endpoint('admin-user-reset-token',async(actor,input)=>{
  const body=z.object({profile_id:z.string().guid(),key:z.string().guid()}).strict().parse(input);await requireDirectoryOwner(db,actor);const profile=await target(actor,body.profile_id);
  adminCreatePasswordResetSchema.parse({params:{id:String(profile.source_user_id)},headers:{idempotencyKey:body.key},body:{}});
  return {...await admin.createPasswordResetTokenByAdmin({userId:profile.source_user_id,actorUserId:actor.source_user_id,idempotencyKey:body.key}),profile_id:body.profile_id};
 });
 endpoint('admin-user-password',async(actor,input)=>{
  const body=z.object({profile_id:z.string().guid(),input:resetPasswordByAdminSchema.shape.body}).strict().parse(input);await requireDirectoryOwner(db,actor);const profile=await target(actor,body.profile_id);
  await admin.resetUserPasswordByAdmin({userId:String(profile.source_user_id),actorUserId:actor.source_user_id,token:body.input.token,newPassword:body.input.newPassword});return {reset:true};
 });
 endpoint('admin-user-recover',async(actor,input)=>{
  const body=z.object({profile_id:z.string().guid(),key:z.string().guid(),input:adminRecoverAccountSchema.shape.body}).strict().parse(input);await requireDirectoryOwner(db,actor);const profile=await target(actor,body.profile_id);
  requireDirectoryAdmin(actor);
  return {...await recoverAccountBySuperadmin({userId:profile.source_user_id,actorUserId:actor.source_user_id,actorSessionEpoch:actor.global_session_epoch,actorFactorId:actor.mfa_factor_id,actorFactorVersion:actor.mfa_factor_version,idempotencyKey:body.key,reason:body.input.reason,meta:{ip:null,user_agent:null,device_type:null,os:null,browser:null,path:'/directory/admin-user-recover'}}),profile_id:body.profile_id};
 });
}
