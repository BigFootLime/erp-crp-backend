import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import type {Request} from 'express';
import {HttpError} from '../utils/httpError';
import {sharedDirectoryClient,projectDirectoryIdentity} from './site-runtime';
import {directoryTargetId} from './admin.facade';
export async function uploadDirectoryAvatar(db:Pool,req:Request,userId:number,key:string,file:Express.Multer.File,meta:unknown){
 const client=sharedDirectoryClient();if(!client||!req.user?.directory_session)throw new HttpError(401,'DIRECTORY_SESSION_REQUIRED','Une nouvelle connexion est requise.');
 const bytes=file.buffer??await fs.readFile(file.path);
 if(file.uploadSecurity?.scanStatus!=='clean'||bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.uploadSecurity.sha256)throw new HttpError(503,'AVATAR_INTEGRITY_ERROR','L’image vérifiée a changé.');
 const result=await client.call('avatar-upload',{directory_session:req.user.directory_session,profile_id:await directoryTargetId(db,userId),key,filename:file.originalname,mime:file.mimetype,base64:bytes.toString('base64'),meta});
 // The next authenticated projection uses the new private source asset UUID.
 await projectDirectoryIdentity(db,await client.validate(req.user.directory_session));return result;
}
export async function readDirectoryAvatar(db:Pool,userId:number){
 const row=(await db.query('SELECT avatar_key,directory_avatar_asset_id,directory_profile_metadata FROM public.users WHERE id=$1 AND directory_profile_id IS NOT NULL',[userId])).rows[0];
 return row?{...row.directory_profile_metadata,avatar_key:row.avatar_key,profile_picture_asset:row.directory_avatar_asset_id?{asset_id:row.directory_avatar_asset_id,status:'AVAILABLE' as const}:null}:null;
}
