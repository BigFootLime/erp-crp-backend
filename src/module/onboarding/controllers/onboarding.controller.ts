import { asyncHandler } from "../../../utils/asyncHandler";
import { z } from "zod";
import { companySchema, progressSchema } from "../validators/onboarding.validators";
import { readSetupCompanies,saveSetupCompany,saveSetupStep } from "../repository/onboarding.repository";
import { getSetupStatus } from "../services/onboarding.service";
import pool from '../../../config/database';
import {sharedDirectoryClient} from '../../../shared-directory/site-runtime';
import {synchronizeDirectoryCompany} from '../../../shared-directory/company.projection';
export const status=asyncHandler(async(req,res)=>{res.setHeader("Cache-Control","no-store");const directory=sharedDirectoryClient(),counts=directory?await directory.call<{login_count:number}>('login-count',{directory_session:req.user!.directory_session}):null;res.json(await getSetupStatus(req.user!.id,counts?.login_count));});
export const progress=asyncHandler(async(req,res)=>{const input=progressSchema.parse(req.body);await saveSetupStep(req.user!.id,input.current_step);res.status(204).end();});
export const companies=asyncHandler(async(req,res)=>{res.setHeader("Cache-Control","no-store");const directory=sharedDirectoryClient();res.json(directory?await directory.call('company-list',{directory_session:req.user!.directory_session,input:{}}):await readSetupCompanies());});
export const company=asyncHandler(async(req,res)=>{
 const input=companySchema.parse(req.body),key=z.string().guid().parse(req.header('Idempotency-Key')),directory=sharedDirectoryClient();
 const result=directory?await directory.call<{biller_id:string}>('company-save',{directory_session:req.user!.directory_session,input:{company:input,key}}):await saveSetupCompany(input,req.user!.id,key);
 if(directory)await synchronizeDirectoryCompany(pool,req.user!.directory_session!);
 res.json({biller_id:result.biller_id});
});
