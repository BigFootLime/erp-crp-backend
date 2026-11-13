import { asyncHandler } from "../../../utils/asyncHandler";
import { z } from "zod";
import { companySchema, progressSchema } from "../validators/onboarding.validators";
import { readSetupCompanies,saveSetupCompany,saveSetupStep } from "../repository/onboarding.repository";
import { getSetupStatus } from "../services/onboarding.service";
import pool from '../../../config/database';
import {sharedDirectoryClient} from '../../../shared-directory/site-runtime';
import {synchronizeDirectoryCompany} from '../../../shared-directory/company.projection';
import { companyRuntimeConfiguration } from '../../entreprises/runtime/company-runtime.config';
import { HttpError } from '../../../utils/httpError';
import { readWorkstationSetup, saveWorkstationSetup } from '../../production/repository/workstation-defaults.repository';
import { workstationDefaultsSchema } from '../../production/domain/workstation-defaults';
export const workstations = asyncHandler(async (req,res) => {
 if(req.businessCompanyAccess?.context.profile==='COMMERCIAL')throw new HttpError(400,'COMMERCIAL_SETUP_STEP_NOT_APPLICABLE','Les postes de fabrication ne concernent pas une entreprise commerciale.');
 res.setHeader('Cache-Control','no-store');res.json(await readWorkstationSetup());
});
export const saveWorkstations = asyncHandler(async (req,res) => {
 if(req.businessCompanyAccess?.context.profile==='COMMERCIAL')throw new HttpError(400,'COMMERCIAL_SETUP_STEP_NOT_APPLICABLE','Les postes de fabrication ne concernent pas une entreprise commerciale.');
 const input=workstationDefaultsSchema.extend({expected_updated_at:z.string().nullable()}).parse(req.body);
 res.json(await saveWorkstationSetup(input,req.user!.id));
});
export const status=asyncHandler(async(req,res)=>{res.setHeader("Cache-Control","no-store");const directory=sharedDirectoryClient(),counts=directory?await directory.call<{login_count:number}>('login-count',{directory_session:req.user!.directory_session}):null;res.json(await getSetupStatus(req.user!.id,counts?.login_count,req.businessCompanyAccess?.context.profile));});
export const progress=asyncHandler(async(req,res)=>{const input=progressSchema.parse(req.body);if(req.businessCompanyAccess?.context.profile==='COMMERCIAL'&&!['company','finance','review'].includes(input.current_step))throw new HttpError(400,'COMMERCIAL_SETUP_STEP_NOT_APPLICABLE','Cette étape ne concerne pas une entreprise commerciale.');await saveSetupStep(req.user!.id,input.current_step);res.status(204).end();});
export const companies=asyncHandler(async(req,res)=>{res.setHeader("Cache-Control","no-store");const directory=companyRuntimeConfiguration().enabled?null:sharedDirectoryClient();res.json(directory?await directory.call('company-list',{directory_session:req.user!.directory_session,input:{}}):await readSetupCompanies());});
export const company=asyncHandler(async(req,res)=>{
 const input=companySchema.parse(req.body),key=z.string().guid().parse(req.header('Idempotency-Key')),directory=companyRuntimeConfiguration().enabled?null:sharedDirectoryClient();
 const result=directory?await directory.call<{biller_id:string}>('company-save',{directory_session:req.user!.directory_session,input:{company:input,key}}):await saveSetupCompany(input,req.user!.id,key);
 if(directory)await synchronizeDirectoryCompany(pool,req.user!.directory_session!);
 res.json({biller_id:result.biller_id});
});
