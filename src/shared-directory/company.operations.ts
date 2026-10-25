import {z} from 'zod';
import type {Express,Request,Response,RequestHandler} from 'express';
import type {Pool} from 'pg';
import {companySchema} from '../module/onboarding/validators/onboarding.validators';
import {readSetupCompanies,saveSetupCompany} from '../module/onboarding/repository/onboarding.repository';
import {validateDirectorySession} from './session.repository';
import {requireDirectoryCompanyConfiguration} from './company-authorization';
import {directoryProfileForSite} from './admin.repository';
type Wrap=(work:(req:Request,res:Response)=>Promise<void>)=>RequestHandler;
export function mountDirectoryCompany(app:Express,db:Pool,wrap:Wrap,authorityId:string,keys:()=>Promise<ReadonlyMap<string,string>>,transport?:typeof fetch){
 const auth=z.object({directory_session:z.string().regex(/^dir_[a-f0-9]{64}$/),input:z.unknown()}).strict();
 app.post('/internal/directory/company-list',wrap(async(req,res)=>{
  const body=auth.parse(req.body);z.object({}).strict().parse(body.input);await validateDirectorySession(db,req.directoryCaller!,body.directory_session);res.json(await readSetupCompanies());
 }));
 app.post('/internal/directory/company-save',wrap(async(req,res)=>{
  const body=auth.parse(req.body),input=z.object({company:companySchema,key:z.string().guid()}).strict().parse(body.input);
  const actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);await requireDirectoryCompanyConfiguration(db,actor,authorityId,await keys(),transport);
  res.json(await saveSetupCompany(input.company,actor.source_user_id,input.key));
 }));
 app.post('/internal/directory/company-snapshot',wrap(async(req,res)=>{
  const body=auth.parse(req.body);z.object({}).strict().parse(body.input);const actor=await validateDirectorySession(db,req.directoryCaller!,body.directory_session);
  const snapshot=(await db.query(`SELECT
   (SELECT count(*)::int FROM public.erp_setup_company_commands) AS revision,
   (SELECT value_text FROM public.erp_settings WHERE key='company.primary_biller_id') AS primary_biller_id,
   coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY biller_id) FROM public.factureur f),'[]'::jsonb) AS billers,
   coalesce((SELECT jsonb_agg(to_jsonb(m)||jsonb_build_object('creator_profile_id',p.profile_id) ORDER BY m.biller_id,m.version) FROM public.finance_legal_mentions m LEFT JOIN public.cerp_directory_profiles p ON p.user_id=m.created_by),'[]'::jsonb) AS mentions`)).rows[0];
  const creators=[...new Set<string>(snapshot.mentions.map((row:{creator_profile_id:string|null})=>row.creator_profile_id).filter(Boolean))],profiles=[];
  for(const creator of creators)profiles.push(await directoryProfileForSite(db,actor.database,creator));
  res.json({...snapshot,profiles});
 }));
}
