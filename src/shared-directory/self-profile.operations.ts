import {z} from 'zod';
import type {Express,Request,Response,RequestHandler} from 'express';
import type {Pool} from 'pg';
import {selfProfilePatchSchema} from '../module/auth/validators/self-profile.validator';
import {updateSelfProfile} from '../module/auth/repository/self-profile.repository';
import {validateDirectorySession} from './session.repository';
import {directoryAuthMetaSchema} from './mfa.operations';
type Wrap=(work:(req:Request,res:Response)=>Promise<void>)=>RequestHandler;
export function mountDirectorySelfProfile(app:Express,db:Pool,wrap:Wrap){
 app.post('/internal/directory/profile-self-update',wrap(async(req,res)=>{
  const body=z.object({directory_session:z.string().regex(/^dir_[a-f0-9]{64}$/),input:selfProfilePatchSchema,meta:directoryAuthMetaSchema}).strict().parse(req.body);
  const actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);
  await updateSelfProfile(actor.source_user_id,body.input,{...body.meta,path:'/directory/profile-self-update'});
  res.json({updated:true});
 }));
}
