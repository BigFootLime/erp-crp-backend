import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {z} from 'zod';
import {canonicalizeAuthUsername} from '../module/auth/domain/auth-identity';
import {strictEmail,strongPasswordReset} from '../module/auth/validators/_helpers';
const identityName=z.string().trim().min(1).max(80).transform(v=>v.toLocaleUpperCase('fr-FR'));
export const ownerBootstrapInput=z.object({
  username:z.string().trim().min(3).max(50).regex(/^[\p{L}\p{N}._-]+$/u).transform(canonicalizeAuthUsername),
  name:identityName,surname:identityName,email:strictEmail,
  password:strongPasswordReset.refine(v=>Buffer.byteLength(v,'utf8')<=72),
  weekly_hours:z.number().positive().max(80),employment_type:z.literal('CDI'),job_title:z.string().trim().min(1).max(80),
}).strict();
/** Private installer input, never public API data or a database migration file. */
export async function prepareOwnerBootstrap(raw:unknown){
  const {password,...profile}=ownerBootstrapInput.parse(raw);
  return {version:1 as const,command_id:randomUUID(),directory_mode:'EMPTY_NO_LEGACY_IMPORT' as const,
    profile:{...profile,avatar_key:null,personal_avatar:null},
    authorization:{is_superadmin:true,role_key:'Administrateur Systeme et Reseau'},
    authentication:{password_hash:await bcrypt.hash(password,12),mfa_required:true,mfa_reenrollment_required:true},
    // 39h (RH H39 scheme) and CDI (employment nature) are distinct facts.
    // No hiring date, daily duration or daily timetable is invented here.
    work_profile_incomplete:true};
}
