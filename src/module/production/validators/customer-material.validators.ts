import {z} from 'zod';
import {materialCommandSchema} from './of-material.validators';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v,'Date calendaire invalide');
const note=z.string().trim().min(10,'Précisez le contexte en dix caractères au moins.').max(2000);
const qty=z.number().finite().positive().max(1e9).multipleOf(.001);
const base=materialCommandSchema.shape;
const call={...base,callId:z.string().uuid(),note};
export const customerMaterialCommandSchema=z.discriminatedUnion('action',[
  z.object({...base,action:z.literal('PREPARE'),needKey:z.string().uuid(),quantity:qty,needDate:date,note}).strict(),
  z.object({...call,action:z.literal('SENT'),reference:z.string().trim().min(3).max(200)}).strict(),
  z.object({...call,action:z.literal('ANNOUNCE'),date}).strict(),
  z.object({...call,action:z.literal('RECEIVE'),quantity:qty,date,reference:z.string().trim().min(1).max(120)}).strict(),
  z.object({...call,action:z.literal('CANCEL')}).strict(),
]);
export type CustomerMaterialCommand=z.infer<typeof customerMaterialCommandSchema>;
