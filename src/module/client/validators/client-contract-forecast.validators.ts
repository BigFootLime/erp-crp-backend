import {z} from 'zod';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const version=z.number().int().positive().max(2147483646);
export const forecastMonthSchema=z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/,'Mois invalide');
const date=z.string().regex(/^(19|20|21)\d{2}-\d{2}-\d{2}$/).refine(value=>{
  const parsed=new Date(value+'T00:00:00Z');
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
},'Date invalide');
export const clientForecastCommandSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('SAVE'),expected_contract_version:version,contract_line_id:uuid,
    month:forecastMonthSchema,expected_version:version.nullable(),quantity:z.number().finite().min(0).max(1_000_000_000)
      .refine(value=>Number(value.toFixed(3))===value,'Maximum trois décimales'),
    delivery_due:date,estimate_date:date,reason:z.string().trim().min(3).max(500).nullable()}).strict(),
  z.object({action:z.literal('CANCEL'),expected_contract_version:version,forecast_id:uuid,
    expected_version:version,reason:z.string().trim().min(3).max(500)}).strict(),
]).superRefine((body,context)=>{
  if(body.action==='SAVE'&&body.delivery_due.slice(0,7)!==body.month)
    context.addIssue({code:z.ZodIssueCode.custom,path:['delivery_due'],message:'L’échéance doit être dans le mois estimé'});
  if(body.action==='SAVE'&&body.expected_version!==null&&!body.reason)
    context.addIssue({code:z.ZodIssueCode.custom,path:['reason'],message:'Précisez le motif de révision'});
});
export const clientForecastQuerySchema=z.object({start_month:forecastMonthSchema.optional(),
  months:z.coerce.number().int().min(1).max(36).default(12),page:z.coerce.number().int().min(1).max(100000).default(1)}).strict();
export type ClientForecastCommand=z.infer<typeof clientForecastCommandSchema>;
export type ClientForecastQuery=z.infer<typeof clientForecastQuerySchema>;
