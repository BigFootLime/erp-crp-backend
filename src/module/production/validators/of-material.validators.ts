import {z} from "zod";
export const materialIdentitySchema=z.object({id:z.coerce.number().int().positive()});
export const materialSourceRefSchema=z.string().uuid();
export const materialCommandSchema=z.object({expectedVersion:z.string().regex(/^[a-f0-9]{64}$/),idempotencyKey:z.string().uuid()}).strict();
const text=z.string().trim().min(1).max(300);
export const materialConfigurationSchema=materialCommandSchema.extend({configuration:z.object({
  operationId:z.string().uuid(),requirements:z.object({grade:text.nullable(),condition:text.nullable(),ownerClientId:z.string().trim().min(1).max(80).nullable(),dimensions:z.record(z.string().min(1).max(40),z.number().finite().positive().max(1e9)),certificates:z.array(text).max(20),manualChecks:z.array(text).max(20)}).strict(),
  supplyMode:z.enum(["PURCHASE","CUSTOMER"]),debitRule:z.object({form:z.enum(["UNIT","BAR","SHEET"]),stockUnit:z.string().trim().min(1).max(20),unitsPerBlank:z.number().finite().positive().max(1e9),kerfPerBlank:z.number().finite().min(0).max(1e9),yieldValidated:z.boolean()}).strict(),
  allowPartial:z.boolean(),supplierId:z.string().uuid().nullable(),destinationId:z.string().uuid().nullable(),
}).strict()}).strict();
export const materialConfirmationSchema=materialCommandSchema.extend({
  selections:z.array(z.object({needKey:z.string().uuid(),batchId:z.string().uuid(),quantity:z.number().finite().positive().max(1e9).multipleOf(.001)}).strict()).max(100),
  futureSelections:z.array(z.object({needKey:z.string().uuid(),lineId:z.string().uuid(),quantity:z.number().finite().positive().max(1e9).multipleOf(.001),requirementsReviewed:z.literal(true)}).strict()).max(100).default([]),
}).strict();
export type MaterialConfirmation=z.infer<typeof materialConfirmationSchema>;
export const materialLotVerificationSchema=materialCommandSchema.extend({
  batchId:z.string().uuid(),grade:text.nullable(),condition:text.nullable(),
  dimensions:z.record(z.string().min(1).max(40),z.number().finite().positive().max(1e9)),
  certificates:z.array(z.object({label:text,documentId:z.string().uuid()}).strict()).max(20),
  evidence:z.string().trim().min(10).max(4000),manualRequirementsChecked:z.boolean(),
}).strict();
export type MaterialLotVerification=z.infer<typeof materialLotVerificationSchema>;
export const materialDebitSchema=materialCommandSchema.extend({
  operationId:z.string().uuid(),
  good:z.number().int().nonnegative().max(1e9),
  scrap:z.number().int().nonnegative().max(1e9),
  scrapReason:z.string().trim().min(1).max(100).nullable(),
  note:z.string().trim().min(10).max(2000),
  sources:z.array(z.object({reservationId:z.string().uuid(),quantity:z.number().finite().positive().max(1e9).multipleOf(.001),expectedVersion:z.number().int().positive()}).strict()).min(1).max(100),
  successorOperationId:z.string().uuid().nullable(),
}).strict().superRefine((v,ctx)=>{
  if(v.good+v.scrap===0)ctx.addIssue({code:'custom',path:['good'],message:'Indiquez les bruts obtenus ou rebutés.'});
  if(v.scrap>0&&!v.scrapReason)ctx.addIssue({code:'custom',path:['scrapReason'],message:'Précisez la cause du rebut.'});
  if(new Set(v.sources.map(s=>s.reservationId)).size!==v.sources.length)ctx.addIssue({code:'custom',path:['sources'],message:'Une réservation ne peut figurer deux fois.'});
});
export type MaterialDebit=z.infer<typeof materialDebitSchema>;
