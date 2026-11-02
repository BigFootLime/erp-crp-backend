import { z } from "zod";
const email=z.string().email().max(254), password=z.string().min(12).max(256), uuid=z.string().uuid();
export const loginSchema=z.object({email,password}).strict();
export const activateSchema=z.object({token:z.string().min(32).max(200),password,consent:z.literal(true)}).strict();
export const recoverSchema=z.object({email}).strict();
export const resetSchema=z.object({token:z.string().min(32).max(200),password}).strict();
export const inviteSchema=z.object({supplier_id:uuid,email,order_ids:z.array(uuid).min(1).max(100),expires_at:z.string().datetime()}).strict();
export const promiseSchema=z.object({promised_date:z.string().date(),promised_quantity:z.coerce.number().positive().max(999999999),reason:z.string().trim().min(3).max(1000),
  estimated_treatment_return_date:z.string().date().optional(),estimate_reason:z.string().trim().min(3).max(1000).optional()}).strict()
 .refine(value=>!value.estimated_treatment_return_date||!!value.estimate_reason,{message:"La base de l’estimation de traitement est requise.",path:["estimate_reason"]});
export const decisionSchema=z.object({decision:z.enum(["ACCEPT","REJECT"]),note:z.string().trim().min(1).max(2000)}).strict();
