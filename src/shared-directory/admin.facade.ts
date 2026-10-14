import type {Request} from 'express';
import type {Pool} from 'pg';
import {z} from 'zod';
import {directoryProfileSchema} from './model';
import {sharedDirectoryClient,projectDirectoryProfile} from './site-runtime';
import {HttpError} from '../utils/httpError';
const entrySchema=z.object({profile:directoryProfileSchema,user:z.record(z.unknown())});
async function entry(db:Pool,raw:unknown){
 const value=entrySchema.parse(raw),local=await projectDirectoryProfile(db,value.profile);
 return {...value.user,id:local.id,username:value.profile.username,email:value.profile.email,role:value.profile.role,roles:value.profile.roles,status:value.profile.status,is_superadmin:value.profile.is_superadmin,avatar_key:value.profile.avatar_key,profile_picture_asset:value.profile.avatar_asset_id?{asset_id:value.profile.avatar_asset_id,status:'AVAILABLE'}:null};
}
export async function directoryAdminCall(db:Pool,req:Request,operation:string,input:unknown){
 const client=sharedDirectoryClient();if(!client)throw new Error('DIRECTORY_DISABLED');
 if(!req.user?.directory_session)throw new HttpError(401,'DIRECTORY_SESSION_REQUIRED','Une nouvelle connexion est requise.');
 return client.call<Record<string,unknown>>(operation,{directory_session:req.user.directory_session,input});
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
export async function directoryAdminToken(db:Pool,req:Request,operation:string,input:unknown,localId:number):Promise<Record<string,unknown>&{replayed:boolean}>{
 const result=await directoryAdminCall(db,req,operation,input);
 const replayed=z.boolean().parse(result.replayed);
 if(result.invitation&&typeof result.invitation==='object')return {...result,replayed,invitation:{...result.invitation,user_id:localId}};
 return {...result,replayed,...('user_id' in result?{user_id:localId}:{})};
}
