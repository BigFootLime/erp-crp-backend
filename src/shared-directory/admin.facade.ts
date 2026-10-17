import type {Request} from 'express';
import type {Pool} from 'pg';
import {z} from 'zod';
import {directoryProfileSchema} from './model';
import {sharedDirectoryClient,projectDirectoryProfile} from './site-runtime';
import {HttpError} from '../utils/httpError';
const entrySchema=z.object({profile:directoryProfileSchema,membership_version:z.number().int().nonnegative().optional(),user:z.record(z.unknown())});
const directoryAdminErrorMap=new Map<string,{status:number;message:string}>([
 ['MFA_STEP_UP_REQUIRED',{status:428,message:'Confirmez votre double authentification pour cette opération.'}],
 ['DIRECTORY_MEMBERSHIP_STALE',{status:409,message:'Les droits de ce compte viennent de changer ; actualisez avant de réessayer.'}],
 ['DIRECTORY_SELF_DEMOTION_FORBIDDEN',{status:409,message:'Un propriétaire Production ne peut pas retirer son propre accès superAdmin.'}],
 ['LAST_DIRECTORY_OWNER',{status:409,message:'Conservez un administrateur Production actif avec MFA.'}],
 ['DIRECTORY_OWNER_MFA_REQUIRED',{status:409,message:'Le compte cible doit être actif et disposer d’un facteur MFA actif.'}],
 ['DIRECTORY_OWNER_STATUS_MANAGED',{status:409,message:'La désactivation d’un propriétaire Production exige le parcours sécurisé dédié.'}],
 ['DIRECTORY_OWNER_REAUTH_REQUIRED',{status:403,message:'Votre autorisation a changé ; reconnectez-vous puis recommencez.'}],
 ['DIRECTORY_OWNER_REQUIRED',{status:403,message:'Cette modification commune exige un administrateur de Production.'}],
 ['DIRECTORY_ADMIN_REQUIRED',{status:403,message:'Accès administrateur requis.'}],
 ['DIRECTORY_PRODUCTION_CONTEXT_REQUIRED',{status:403,message:'Cette opération doit être réalisée depuis Production.'}],
 ['DIRECTORY_PROFILE_NOT_FOUND',{status:404,message:'Profil annuaire inconnu.'}],
 ['DIRECTORY_UNAVAILABLE',{status:503,message:'L’annuaire commun est momentanément indisponible.'}],
]);
function mapDirectoryAdminError(error:unknown){
 if(error instanceof HttpError)return error;
 const code=error&&typeof error==='object'&&typeof (error as {code?:unknown}).code==='string'?(error as {code:string}).code:null;
 const mapped=code?directoryAdminErrorMap.get(code):undefined;
 return mapped?new HttpError(mapped.status,code!,mapped.message):error;
}
async function entry(db:Pool,raw:unknown){
 const value=entrySchema.parse(raw),local=await projectDirectoryProfile(db,value.profile);
 return {...value.user,id:local.id,username:value.profile.username,email:value.profile.email,role:value.profile.role,roles:value.profile.roles,status:value.profile.status,is_superadmin:value.profile.is_superadmin,membership_version:value.membership_version??0,avatar_key:value.profile.avatar_key,profile_picture_asset:value.profile.avatar_asset_id?{asset_id:value.profile.avatar_asset_id,status:'AVAILABLE'}:null};
}
export async function directoryAdminCall(db:Pool,req:Request,operation:string,input:unknown){
 const client=sharedDirectoryClient();if(!client)throw new Error('DIRECTORY_DISABLED');
 if(!req.user?.directory_session)throw new HttpError(401,'DIRECTORY_SESSION_REQUIRED','Une nouvelle connexion est requise.');
 try{return await client.call<Record<string,unknown>>(operation,{directory_session:req.user.directory_session,input});}catch(error){throw mapDirectoryAdminError(error);}
}
export async function directoryTargetId(db:Pool,localId:number){
 const value=(await db.query('SELECT directory_profile_id FROM public.users WHERE id=$1',[localId])).rows[0]?.directory_profile_id;
 if(!value)throw new HttpError(404,'USER_NOT_FOUND','Ce compte n’appartient pas au nouvel annuaire commun.');
 return z.string().uuid().parse(value);
}
export async function directoryAdminList(db:Pool,req:Request){
 const result=await directoryAdminCall(db,req,'admin-users',{});const rows=z.array(entrySchema).parse(result);
 const users=[];for(const row of rows)users.push(await entry(db,row));return users;
}
export async function directoryAdminUser(db:Pool,req:Request,operation:string,input:unknown){
 const value=await directoryAdminCall(db,req,operation,input);return {user:await entry(db,value),...(typeof value.replayed==='boolean'?{replayed:value.replayed}:{})};
}
export async function directoryAdminSuperadmin(db:Pool,req:Request,localId:number,input:{is_superadmin:boolean;expected_version:number}){
 const profileId=await directoryTargetId(db,localId);
 const result=z.object({profile_id:z.string().uuid(),is_superadmin:z.boolean(),version:z.number().int().nonnegative(),changed:z.boolean()}).parse(await directoryAdminCall(db,req,'admin-user-superadmin',{profile_id:profileId,...input}));
 const refreshed=await directoryAdminUser(db,req,'admin-user',{profile_id:profileId});
 return {...refreshed,changed:result.changed};
}
export async function directoryAdminToken(db:Pool,req:Request,operation:string,input:unknown,localId:number):Promise<Record<string,unknown>&{replayed:boolean}>{
 const result=await directoryAdminCall(db,req,operation,input);
 const replayed=z.boolean().parse(result.replayed);
 if(result.invitation&&typeof result.invitation==='object')return {...result,replayed,invitation:{...result.invitation,user_id:localId}};
 return {...result,replayed,...('user_id' in result?{user_id:localId}:{})};
}
