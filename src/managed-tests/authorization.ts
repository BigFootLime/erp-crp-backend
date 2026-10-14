import {z} from 'zod';
import {ManagerError} from './model';

const identitySchema=z.object({user:z.object({id:z.number().int().positive(),mfa:z.literal(true),mfa_verified_at:z.number().int()})});
export async function authorizeManager(authorization:string|undefined,commonApi:string,fetcher:typeof fetch=fetch) {
  if(!authorization?.startsWith('Bearer ')) throw new ManagerError(401,'MANAGED_AUTH_REQUIRED','Connectez-vous à la Test commune pour gérer les bases.');
  const target=new URL(commonApi);
  if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname) || target.protocol!=='http:') throw new Error('MANAGED_AUTH_SOURCE_INVALID');
  const headers={Authorization:authorization,'X-CERP-Database':'cerp_test'};
  const responses=await Promise.all(['/environment','/auth/me','/auth/access-profile'].map(p=>fetcher(`${commonApi}${p}`,{headers,redirect:'error',signal:AbortSignal.timeout(5000)})));
  if(responses.some(r=>r.status===401)) throw new ManagerError(401,'MANAGED_AUTH_REQUIRED','Reconnectez-vous à la Test commune pour gérer les bases.');
  if(responses.some(r=>!r.ok)) throw new ManagerError(403,'MANAGED_ADMIN_REQUIRED','La gestion des bases exige un administrateur de la Test commune.');
  const [environment,identity,profile]=await Promise.all(responses.map(r=>r.json()));
  if(environment.database!=='cerp_test' || profile.is_superadmin!==true) throw new ManagerError(403,'MANAGED_ADMIN_REQUIRED','La gestion des bases exige un administrateur de la Test commune.');
  const parsed=identitySchema.safeParse(identity);
  const age=parsed.success ? Math.floor(Date.now()/1000)-parsed.data.user.mfa_verified_at:Infinity;
  if(!parsed.success || age<0 || age>300) throw new ManagerError(428,'MFA_STEP_UP_REQUIRED','Confirmez votre double authentification pour gérer les bases.');
  return parsed.data.user.id;
}
