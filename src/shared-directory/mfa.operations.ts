import {z} from 'zod';
import type {Express,RequestHandler} from 'express';
import type {Pool} from 'pg';
import {enrollMfaSchema,manageMfaSchema,stepUpMfaSchema,updateMfaPolicySchema} from '../module/auth/validators/auth.validator';
import {beginOwnMfaEnrollment,beginMfaReplacement,getMfaStatus,stepUpMfa,regenerateRecoveryCodes,revokeOwnMfa,getMfaPolicyConfiguration,updateMfaPolicyConfiguration,type MfaAuditMeta} from '../module/auth/services/mfa.service';
import {validateDirectorySession,bindChallenge,createDirectorySession} from './session.repository';
import {HttpError} from '../utils/httpError';
export const directoryAuthMetaSchema=z.object({ip:z.string().max(80).nullable(),user_agent:z.string().max(512).nullable(),device_type:z.string().max(80).nullable(),os:z.string().max(80).nullable(),browser:z.string().max(80).nullable()}).strict();
const session=z.string().regex(/^dir_[a-f0-9]{64}$/);
/** Each protected operation resolves its actor at the authority; no site user ID is trusted. */
export function mountDirectoryMfa(app:Express,db:Pool,sourceJwtSecret:string,wrap:(work:any)=>RequestHandler){
 const endpoint=(name:string,input:z.ZodTypeAny,work:(identity:Awaited<ReturnType<typeof validateDirectorySession>>,body:any,meta:MfaAuditMeta)=>Promise<unknown>)=>{
  app.post(`/internal/directory/${name}`,wrap(async(req:any,res:any)=>{
   const body=z.object({directory_session:session,input,meta:directoryAuthMetaSchema}).strict().parse(req.body);
   const identity=await validateDirectorySession(db,req.directoryCaller,body.directory_session);
   res.json(await work(identity,body.input,{...body.meta,path:`/directory/${req.directoryCaller}/${name}`}));
  }));
 };
 endpoint('mfa-status',z.object({}).strict(),identity=>getMfaStatus(identity.source_user_id));
 endpoint('mfa-step-up',stepUpMfaSchema,async(identity,body,meta)=>{
  const result=await stepUpMfa(identity.source_user_id,body.code,meta);
  return createDirectorySession(db,identity.database,result.token,sourceJwtSecret);
 });
 endpoint('mfa-enroll',enrollMfaSchema,async(identity,body,meta)=>{
  const result=await beginOwnMfaEnrollment(identity.source_user_id,body.current_password,body.device_label,meta);
  await bindChallenge(db,identity.database,result.challenge_token);return result;
 });
 endpoint('mfa-replace',manageMfaSchema,async(identity,body,meta)=>{
  const result=await beginMfaReplacement(identity.source_user_id,body.current_password,body.code,body.device_label,meta);
  await bindChallenge(db,identity.database,result.challenge_token);return result;
 });
 endpoint('mfa-recovery-codes',manageMfaSchema,(identity,body,meta)=>regenerateRecoveryCodes(identity.source_user_id,body.current_password,body.code,meta));
 endpoint('mfa-revoke',manageMfaSchema,(identity,body,meta)=>revokeOwnMfa(identity.source_user_id,body.current_password,body.code,meta));
 endpoint('mfa-policy',z.object({}).strict(),async()=>getMfaPolicyConfiguration());
 endpoint('mfa-policy-update',updateMfaPolicySchema,async(identity,body,meta)=>{
  const owner=(await db.query("SELECT 1 FROM public.cerp_directory_memberships WHERE profile_id=$1::uuid AND database_id='cerp_prod' AND status='Active' AND is_superadmin=true",[identity.profile_id])).rows.length>0;
  if(!owner)throw new HttpError(403,'DIRECTORY_OWNER_REQUIRED','La politique commune exige un administrateur de Production.');
  if(!['optional','required_for_all'].includes(body.policy))throw new HttpError(409,'DIRECTORY_MFA_POLICY_INVALID','Choisissez la MFA facultative pour les salariés ou obligatoire pour tous. Elle reste obligatoire pour les administrateurs.');
  return updateMfaPolicyConfiguration({userId:identity.source_user_id,password:body.current_password,code:body.code,policy:body.policy,meta});
 });
}
