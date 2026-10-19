import express from 'express';
import {z} from 'zod';
import type {Pool} from 'pg';
import {verifyDirectoryCall} from './call-signature';
import {consumeCallNonce,assertDirectoryIdentity,assertDirectoryApplicationRole,bindChallenge,assertChallengeSite,hasActiveMembership,ensureTestMembership,createDirectorySession,validateDirectorySession} from './session.repository';
import {loginUser} from '../module/auth/services/auth.service';
import {verifyMfaChallenge} from '../module/auth/services/mfa.service';
import {loginSchema,verifyMfaChallengeSchema} from '../module/auth/validators/auth.validator';
import {createAuthRateLimitMiddleware} from '../module/auth/middlewares/auth-rate-limit.middleware';
import {canonicalizeAuthUsername} from '../module/auth/domain/auth-identity';
import {registerSharedTestProfile} from './registration.repository';
import {testRegistrationSchema,AVATAR_KEYS} from '../module/auth/validators/test-registration.validator';
import {mountDirectoryMfa} from './mfa.operations';
import {mountDirectoryPasswords} from './password.operations';
import {mountDirectoryAdmin} from './admin.operations';
import {mountDirectoryAccountRequests} from './account-request.operations';
import {expireDirectoryAccountRequests} from './account-request.repository';
import {accountRequiresMfa,normalizeMfaPolicy} from '../module/auth/domain/mfa-policy';
import {mountDirectoryCompany} from './company.operations';
import {mountDirectoryAvatars} from './avatar.operations';
import {mountDirectorySelfProfile} from './self-profile.operations';
import {directoryProfileForSite} from './admin.repository';
import {mountDirectoryTabletPins} from './tablet-pin.operations';
const sessionInput=z.object({directory_session:z.string().max(100)}).strict();
const authMeta=z.object({ip:z.string().max(80).nullable(),user_agent:z.string().max(512).nullable(),device_type:z.string().max(80).nullable(),os:z.string().max(80).nullable(),browser:z.string().max(80).nullable()}).strict();
type Options={db:Pool;directoryId:string;sourceJwtSecret:string;keys:ReadonlyMap<string,string>|(()=>Promise<ReadonlyMap<string,string>>);registrationOpen?:boolean;registrationHashKey?:string};
declare global {namespace Express {interface Request {directoryCaller?:string;}}}
/** A private loopback service owns credentials/MFA. Site APIs have no source key. */
export function createDirectoryServer(options:Options){
 const app=express();app.disable('x-powered-by');
 app.use('/internal/directory',express.raw({type:'application/json',limit:'15mb'}),async(req,res,next)=>{
  try{
   if(req.method!=='POST'||!Buffer.isBuffer(req.body))throw new Error('DIRECTORY_CALL_REJECTED');
   if(req.originalUrl!=='/internal/directory/avatar-upload'&&req.body.length>16384)throw new Error('DIRECTORY_CALL_TOO_LARGE');
   const headers=Object.fromEntries(Object.entries(req.headers).map(([k,v])=>[k,typeof v==='string'?v:undefined]));
   const caller=verifyDirectoryCall(headers,typeof options.keys==='function'?await options.keys():options.keys,req.method,req.originalUrl,req.body);
   await consumeCallNonce(options.db,caller.nonce,caller.expires_at);
   req.directoryCaller=caller.site;req.body=JSON.parse(req.body.toString('utf8'));next();
  }catch{res.status(401).json({code:'DIRECTORY_CALL_REJECTED',message:'Appel annuaire refusé.'});}
 });
 const wrap=(work:(req:express.Request,res:express.Response)=>Promise<void>):express.RequestHandler=>(req,res,next)=>{void work(req,res).catch(next);};
 app.post('/internal/directory/info',wrap(async(req,res)=>{z.object({}).strict().parse(req.body);res.json({directory_id:options.directoryId,schema_version:1,capabilities:['shared-auth-mfa','shared-users','shared-company','shared-avatar'],import_mode:'EMPTY_NO_LEGACY_IMPORT'});}));
 app.post('/internal/directory/registration-options',wrap(async(req,res)=>{z.object({}).strict().parse(req.body);res.json({enabled:!!options.registrationOpen&&req.directoryCaller!=='cerp_prod',database:req.directoryCaller,avatars:AVATAR_KEYS,role:'superAdmin'});}));
 app.post('/internal/directory/register',wrap(async(req,res)=>{
  const body=z.object({input:testRegistrationSchema,key:z.string().uuid(),meta:authMeta}).strict().parse(req.body),site=req.directoryCaller!;
  if(!options.registrationOpen||site==='cerp_prod'||!options.registrationHashKey){res.status(403).json({code:'TEST_REGISTRATION_DISABLED',message:'La création de compte est fermée.'});return;}
  await registerSharedTestProfile(options.db,site,body.input,body.key,options.registrationHashKey);
  const result=await loginUser(body.input.username,body.input.password,body.meta);
  if('challenge_token' in result){await bindChallenge(options.db,site,result.challenge_token);res.status(201).json(result);return;}
  if(!('token' in result))throw new Error('DIRECTORY_MFA_REQUIRED');res.status(201).json(await createDirectorySession(options.db,site,result.token,options.sourceJwtSecret));
 }));
 app.post('/internal/directory/validate-session',wrap(async(req,res)=>{
  const body=sessionInput.parse(req.body);res.json(await validateDirectorySession(options.db,req.directoryCaller!,body.directory_session));
 }));
 app.post(['/internal/directory/validate-actor','/internal/directory/validate-actor-v2'],wrap(async(req,res)=>{
  const body=z.object({profile_id:z.string().uuid()}).strict().parse(req.body),profile=await directoryProfileForSite(options.db,req.directoryCaller!,body.profile_id);
  const row=(await options.db.query(`SELECT coalesce(e.session_epoch,0)::text AS epoch,coalesce(m.version,0) AS version,f.id AS factor_id,f.version AS factor_version,
   u.is_superadmin,u.mfa_required,u.mfa_reenrollment_required,u.role,
   coalesce((SELECT array_agg(ura.role_key) FROM public.user_role_assignments ura WHERE ura.user_id=u.id),ARRAY[u.role]) AS roles,
   (SELECT value_text FROM public.erp_settings WHERE key='security.mfa_policy') AS mfa_policy
   FROM public.cerp_directory_profiles p JOIN public.users u ON u.id=p.user_id LEFT JOIN public.realtime_session_epochs e ON e.user_id=p.user_id
   LEFT JOIN public.cerp_directory_memberships m ON m.profile_id=p.profile_id AND m.database_id=$2
   LEFT JOIN public.user_mfa_factors f ON f.user_id=p.user_id AND f.state='ACTIVE' WHERE p.profile_id=$1::uuid`,[body.profile_id,req.directoryCaller!])).rows[0];
  const mfaRequired=row.mfa_reenrollment_required||accountRequiresMfa({policy:normalizeMfaPolicy(row.mfa_policy),isSuperadmin:row.is_superadmin||profile.is_superadmin,role:row.role,roles:row.roles,hasActiveFactor:!!row.factor_id,mfaRequired:row.mfa_required});
  res.json({profile,global_session_epoch:Number(row.epoch),membership_version:row.version,mfa_factor_id:row.factor_id??null,mfa_factor_version:row.factor_version??null,...(req.path.endsWith('-v2')?{mfa_required:mfaRequired}:{})});
 }));
 app.post('/internal/directory/profile-roster',wrap(async(req,res)=>{
  const body=sessionInput.parse(req.body),actor=await validateDirectorySession(options.db,req.directoryCaller!,body.directory_session);
  const ids=(await options.db.query('SELECT profile_id FROM public.cerp_directory_profiles ORDER BY created_at,profile_id')).rows,profiles=[];
  for(const id of ids)profiles.push(await directoryProfileForSite(options.db,actor.database,id.profile_id));res.json(profiles);
 }));
 app.post('/internal/directory/login-count',wrap(async(req,res)=>{
  const body=sessionInput.parse(req.body),actor=await validateDirectorySession(options.db,req.directoryCaller!,body.directory_session);
  res.json({login_count:(await options.db.query('SELECT count(*)::int n FROM public.auth_login_logs WHERE user_id=$1 AND success',[actor.source_user_id])).rows[0].n});
 }));
 app.post('/internal/directory/login',createAuthRateLimitMiddleware('login',undefined,req=>[
  {dimension:'ip',value:`directory-site:${req.directoryCaller}`},
  {dimension:'username',value:canonicalizeAuthUsername(String(req.body?.input?.username??''))},
 ]),wrap(async(req,res)=>{
  const body=z.object({input:loginSchema,meta:authMeta}).strict().parse(req.body),site=req.directoryCaller!;
  const username=canonicalizeAuthUsername(body.input.username);
  const user=(await options.db.query('SELECT id FROM public.users WHERE upper(username)=upper($1) AND status=\'Active\'',[username])).rows[0];
  if(user && site!=='cerp_prod')await ensureTestMembership(options.db,site,user.id);
  if(!await hasActiveMembership(options.db,site,username)){res.status(401).json({code:'AUTH_INVALID',message:'Identifiants invalides'});return;}
  const result=await loginUser(username,body.input.password,body.meta);
  if('challenge_token' in result){await bindChallenge(options.db,site,result.challenge_token);res.json(result);return;}
  if(!('token' in result))throw new Error('DIRECTORY_MFA_REQUIRED');
  res.json(await createDirectorySession(options.db,site,result.token,options.sourceJwtSecret));
 }));
 app.post('/internal/directory/verify-mfa',createAuthRateLimitMiddleware('mfa',undefined,req=>[
  {dimension:'ip',value:`directory-site:${req.directoryCaller}`},
  {dimension:'token',value:typeof req.body?.input?.challenge_token==='string'?req.body.input.challenge_token:null},
 ]),wrap(async(req,res)=>{
  const body=z.object({input:verifyMfaChallengeSchema,meta:authMeta}).strict().parse(req.body),site=req.directoryCaller!;
   const tabletDeviceId=await assertChallengeSite(options.db,site,body.input.challenge_token);
  const result=await verifyMfaChallenge(body.input.challenge_token,body.input.code,{...body.meta,path:`/directory/${site}/auth/mfa/verify`});
   const session=await createDirectorySession(options.db,site,result.token,options.sourceJwtSecret,tabletDeviceId??undefined);
  res.json({...session,...('recovery_codes' in result?{recovery_codes:result.recovery_codes}:{})});
 }));
 mountDirectoryMfa(app,options.db,options.sourceJwtSecret,wrap);
 mountDirectoryPasswords(app,wrap);
 mountDirectoryAdmin(app,options.db,wrap);
 mountDirectoryAccountRequests(app,options.db,wrap);
 mountDirectoryCompany(app,options.db,wrap);
 mountDirectoryAvatars(app,options.db,wrap);
 mountDirectorySelfProfile(app,options.db,wrap);
 mountDirectoryTabletPins(app,options.db,options.sourceJwtSecret,wrap);
 app.use((_req,res)=>res.status(404).json({code:'DIRECTORY_OPERATION_UNKNOWN',message:'Opération annuaire inconnue.'}));
 app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  const e=error as Error&{status?:number;code?:string};
  if(process.env.NODE_ENV==='test'&&process.env.CERP_DIRECTORY_FIXTURE_DIAGNOSTICS==='true')console.error(JSON.stringify({type:'directory_fixture_diagnostic',name:e.name,code:e.code??null,permission_object:/^permission denied for (table|sequence|schema|function) [a-z_0-9]+$/.test(e.message)?e.message:null,frames:e.stack?.split('\n').filter(line=>line.trim().startsWith('at ')).slice(0,8)}));
  const reject=e.message?.startsWith('DIRECTORY_');
  res.status(error instanceof z.ZodError?400:reject?401:e.status??503).json({code:reject?e.message:e.code??'DIRECTORY_UNAVAILABLE',message:reject?'Votre accès doit être vérifié à nouveau.':e.status===401?'Identifiants invalides':'L’annuaire est momentanément indisponible.'});
 });
 let cleanupTimer:ReturnType<typeof setInterval>|undefined;
 let cleanupRunning=false;
 const cleanup=async()=>{
  if(cleanupRunning)return;
  cleanupRunning=true;
  try{await expireDirectoryAccountRequests(options.db,500);}
  finally{cleanupRunning=false;}
 };
 return {app,initialize:async()=>{
  await assertDirectoryIdentity(options.db,options.directoryId);
  if(process.env.NODE_ENV!=='test')await assertDirectoryApplicationRole(options.db);
  await cleanup();
  if(!cleanupTimer){cleanupTimer=setInterval(()=>{void cleanup().catch(()=>console.error(JSON.stringify({type:'directory_account_request_cleanup_failed'})));},60_000);cleanupTimer.unref();}
 },close:()=>{if(cleanupTimer)clearInterval(cleanupTimer);cleanupTimer=undefined;}};
}
