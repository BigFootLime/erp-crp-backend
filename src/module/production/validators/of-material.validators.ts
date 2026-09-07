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
export const materialConfirmationSchema=materialCommandSchema.extend({selections:z.array(z.object({needKey:z.string().uuid(),batchId:z.string().uuid(),quantity:z.number().finite().positive().max(1e9).multipleOf(.001)}).strict()).max(100)}).strict();
