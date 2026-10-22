import type {Pool} from 'pg';
import type {DirectorySession,MfaDirectorySession} from './model';
import {HttpError} from '../utils/httpError';
export async function isDirectoryOwner(db:Pool,identity:Pick<DirectorySession,'profile_id'>){
 return (await db.query("SELECT 1 FROM public.cerp_directory_memberships m JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id JOIN public.users u ON u.id=p.user_id WHERE m.profile_id=$1::uuid AND m.database_id='cerp_prod' AND m.status='Active' AND m.is_superadmin AND u.status='Active'",[identity.profile_id])).rows.length>0;
}
export function requireDirectoryAdmin(identity:DirectorySession):asserts identity is MfaDirectorySession{
 if(!identity.is_superadmin)throw new HttpError(403,'DIRECTORY_ADMIN_REQUIRED','Accès administrateur requis.');
 requireDirectoryRecentMfa(identity);
}
export function requireDirectoryRecentMfa(identity:DirectorySession):asserts identity is MfaDirectorySession{
 const elapsed=identity.mfa_verified_at===null?NaN:Date.now()-new Date(identity.mfa_verified_at).getTime();
 if(!identity.mfa_factor_id||identity.mfa_factor_version===null||!identity.mfa_method||!Number.isFinite(elapsed)||elapsed<0||elapsed>300000)throw new HttpError(428,'MFA_STEP_UP_REQUIRED','Confirmez votre double authentification pour cette opération.');
}
export async function requireDirectoryOwner(db:Pool,identity:DirectorySession){
 requireDirectoryAdmin(identity);
 if(!await isDirectoryOwner(db,identity))throw new HttpError(403,'DIRECTORY_OWNER_REQUIRED','Cette modification commune exige un administrateur de Production.');
}
