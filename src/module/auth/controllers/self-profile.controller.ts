import type {RequestHandler} from 'express';
import pool from '../../../config/database';
import {getClientIp,parseDevice} from '../../../utils/requestMeta';
import {HttpError} from '../../../utils/httpError';
import {selfProfilePatchSchema} from '../validators/self-profile.validator';
import {readDirectorySelfProfile,readSelfProfile,updateSelfProfile} from '../repository/self-profile.repository';
import {sharedDirectoryClient,projectDirectoryIdentity} from '../../../shared-directory/site-runtime';
import {readDirectoryAvatar} from '../../../shared-directory/avatar.facade';

export const getSelfProfile:RequestHandler=async(req,res,next)=>{try{
 if(!req.user)throw new HttpError(401,'AUTH_REQUIRED','Connexion requise.');
 const directory=sharedDirectoryClient();
 const profile=directory?await readDirectorySelfProfile(req.user.id):await readSelfProfile(req.user.id);
 res.json({profile:{...profile,...(directory?await readDirectoryAvatar(pool,req.user.id):{})}});
}catch(error){next(error);}};

export const patchSelfProfile:RequestHandler=async(req,res,next)=>{try{
 if(!req.user)throw new HttpError(401,'AUTH_REQUIRED','Connexion requise.');
 const patch=selfProfilePatchSchema.parse(req.body),ua=req.headers['user-agent']??null,device=parseDevice(ua);
 const meta={ip:getClientIp(req),user_agent:ua,device_type:device.device_type,os:device.os,browser:device.browser};
 const directory=sharedDirectoryClient();
 if(directory){
  if(!req.user.directory_session)throw new HttpError(401,'DIRECTORY_SESSION_REQUIRED','Une nouvelle connexion est requise.');
  await directory.call('profile-self-update',{directory_session:req.user.directory_session,input:patch,meta});
  await projectDirectoryIdentity(pool,await directory.validate(req.user.directory_session));
 }else await updateSelfProfile(req.user.id,patch,{...meta,path:'/auth/me/profile'});
 const profile=directory?await readDirectorySelfProfile(req.user.id):await readSelfProfile(req.user.id);
 res.json({profile:{...profile,...(directory?await readDirectoryAvatar(pool,req.user.id):{})}});
}catch(error){next(error);}};
