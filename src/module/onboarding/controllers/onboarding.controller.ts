import { asyncHandler } from "../../../utils/asyncHandler";
import { z } from "zod";
import { companySchema, progressSchema } from "../validators/onboarding.validators";
import { readSetupCompanies,saveSetupCompany,saveSetupStep } from "../repository/onboarding.repository";
import { getSetupStatus } from "../services/onboarding.service";
export const status=asyncHandler(async(req,res)=>{res.setHeader("Cache-Control","no-store");res.json(await getSetupStatus(req.user!.id));});
export const progress=asyncHandler(async(req,res)=>{const input=progressSchema.parse(req.body);await saveSetupStep(req.user!.id,input.current_step);res.status(204).end();});
export const companies=asyncHandler(async(_req,res)=>{res.setHeader("Cache-Control","no-store");res.json(await readSetupCompanies());});
export const company=asyncHandler(async(req,res)=>{
 const result=await saveSetupCompany(companySchema.parse(req.body),req.user!.id,z.string().uuid().parse(req.header('Idempotency-Key')));
 res.json({biller_id:result.biller_id});
});
