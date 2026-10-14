import {z} from 'zod';
import type {Express,Request,Response,RequestHandler} from 'express';
import {activateAccountSchema,forgotPasswordSchema,resetPasswordSchema} from '../module/auth/validators/auth.validator';
import {activateAccountWithInvitation,requestPasswordReset,resetPasswordWithToken} from '../module/auth/services/auth.service';
import {createAuthRateLimitMiddleware} from '../module/auth/middlewares/auth-rate-limit.middleware';
import {directoryAuthMetaSchema} from './mfa.operations';
type Wrap=(work:(req:Request,res:Response)=>Promise<void>)=>RequestHandler;
/** Canonical reset/invitation consumption stays at the sole credential owner. */
export function mountDirectoryPasswords(app:Express,wrap:Wrap){
 const limit=(kind:'forgotPassword'|'resetPassword')=>createAuthRateLimitMiddleware(kind,undefined,req=>[{dimension:'ip',value:`directory-site:${req.directoryCaller}`}]);
 app.post('/internal/directory/password-forgot',limit('forgotPassword'),wrap(async(req,res)=>{
  const body=z.object({input:forgotPasswordSchema,meta:directoryAuthMetaSchema}).strict().parse(req.body);
  if(req.authRateLimit?.suppressAction!==true)await requestPasswordReset(body.input.usernameOrEmail,body.meta);
  res.json({accepted:true});
 }));
 app.post('/internal/directory/password-reset',limit('resetPassword'),wrap(async(req,res)=>{
  const body=z.object({input:resetPasswordSchema,meta:directoryAuthMetaSchema}).strict().parse(req.body);
  await resetPasswordWithToken(body.input.token,body.input.newPassword,body.meta);res.json({reset:true});
 }));
 app.post('/internal/directory/account-activate',limit('resetPassword'),wrap(async(req,res)=>{
  const body=z.object({input:activateAccountSchema,meta:directoryAuthMetaSchema}).strict().parse(req.body);
  res.json(await activateAccountWithInvitation(body.input.token,body.input.newPassword,body.meta));
 }));
}
