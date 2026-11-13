import {z} from 'zod';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Express,Request,Response,RequestHandler} from 'express';
import type {Pool} from 'pg';
import {validateDirectorySession} from './session.repository';
import {requireDirectoryAdmin,isDirectoryOwner} from './authority';
import {directoryProfileForSite} from './admin.repository';
import {directoryAuthMetaSchema} from './mfa.operations';
import {uploadUserAvatar} from '../module/auth/repository/avatar.repository';
import {validateSecureUploadBuffer,ensurePrivateUploadDirectory,writeSecureBufferToDestination,cleanupSecureBufferDestination,releaseSecureUploadOwnership} from '../shared/uploads/secure-upload';
import {getTmpStoragePath} from '../utils/cerpStorage';
import {authorizeOperationalMediaRead} from '../module/operational-media/services/operational-media.service';
import {sendSecureStoredFile} from '../shared/uploads/secure-download';
import {HttpError} from '../utils/httpError';
type Wrap=(work:(req:Request,res:Response)=>Promise<void>)=>RequestHandler;
const session=z.string().regex(/^dir_[a-f0-9]{64}$/);
export function mountDirectoryAvatars(app:Express,db:Pool,wrap:Wrap){
 app.post('/internal/directory/avatar-upload',wrap(async(req,res)=>{
  const body=z.object({directory_session:session,profile_id:z.string().guid(),key:z.string().guid(),filename:z.string().max(254),mime:z.enum(['image/png','image/jpeg','image/gif','image/webp']),base64:z.string().min(4).max(14*1024*1024),meta:directoryAuthMetaSchema}).strict().parse(req.body);
  const actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session),target=await directoryProfileForSite(db,actor.database,body.profile_id);
  if(actor.profile_id!==body.profile_id){requireDirectoryAdmin(actor);const protectedTarget=(await db.query("SELECT 1 FROM public.cerp_directory_memberships WHERE profile_id=$1::uuid AND database_id='cerp_prod'",[body.profile_id])).rows.length>0;if(protectedTarget&&!await isDirectoryOwner(db,actor))throw new HttpError(403,'DIRECTORY_OWNER_REQUIRED','Ce compte dispose d’un accès Production.');}
  const bytes=Buffer.from(body.base64,'base64');if(bytes.toString('base64')!==body.base64)throw new HttpError(400,'AVATAR_ENCODING_INVALID','Image invalide.');
  const abort=new AbortController();req.once('aborted',()=>abort.abort());
  const file=await validateSecureUploadBuffer('image',bytes,body.filename,body.mime,abort.signal);
  const temporary=path.join(ensurePrivateUploadDirectory(getTmpStoragePath('directory-avatars'),getTmpStoragePath()),`${randomUUID()}.part`);
  const ownership=await writeSecureBufferToDestination(bytes,temporary);file.path=temporary;
  try{res.json(await uploadUserAvatar({userId:target.source_user_id,actorId:actor.source_user_id,key:body.key,file,meta:{...body.meta,path:'/directory/avatar-upload'}}));}
  finally{releaseSecureUploadOwnership([file]);await cleanupSecureBufferDestination(ownership);}
 }));
 app.post('/internal/directory/avatar-content',wrap(async(req,res)=>{
  const body=z.object({directory_session:session,asset_id:z.string().guid()}).strict().parse(req.body),actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);
  const media=await authorizeOperationalMediaRead({assetId:body.asset_id,userId:actor.source_user_id});
  if(media.asset.owner_type!=='user'||media.asset.module_key!=='chat')throw new HttpError(404,'MEDIA_NOT_FOUND','Avatar introuvable.');
  await sendSecureStoredFile(res,{filePath:media.filePath,allowedRoots:media.allowedRoots,filename:'avatar',mimeType:media.mimeType,expectedSha256:media.expectedSha256,snapshotVerifiedBytes:true,maxSnapshotBytes:10*1024*1024,download:false,integrityError:{status:503,code:'MEDIA_INTEGRITY_ERROR',message:'L’intégrité de l’avatar ne peut pas être confirmée.'}});
 }));
}
