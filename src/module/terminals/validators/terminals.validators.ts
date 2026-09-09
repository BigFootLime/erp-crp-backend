import { z } from "zod";
import { TERMINAL_KINDS } from "../domain/terminal-policy";
export const uuid = z.string().uuid();
export const scopeSchema = z
  .object({ of_id: z.coerce.number().int().positive(), operation_id: uuid })
  .strict();
export const pairingSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[a-fA-F0-9]{32}$/),
    kind: z.enum(TERMINAL_KINDS),
  })
  .strict();
export const identifySchema = z
  .object({
    pin: z.string().regex(/^\d{4}$/),
    app_version: z.string().max(64).optional(),
  })
  .strict();
export const enrollSchema = z
  .object({
    label: z.string().trim().min(2).max(120),
    site_code: z.string().trim().min(1).max(64),
    kind: z.enum(TERMINAL_KINDS).default("OPERATOR"),
    machine_id: uuid.nullish(),
    warehouse_id: uuid.nullish(),
    auto_lock_seconds: z.number().int().min(30).max(3600).default(180),
    session_max_seconds: z.number().int().min(300).max(86400).default(28800),
  })
  .strict().superRefine((value,ctx)=>{
    if(value.kind==='OPERATOR'&&!value.machine_id)ctx.addIssue({code:'custom',path:['machine_id'],message:'Choisissez la machine du poste opérateur.'});
    if(['RECEPTION','OF_PROCUREMENT'].includes(value.kind)&&value.machine_id)ctx.addIssue({code:'custom',path:['machine_id'],message:'Ce terminal est rattaché au site et au magasin.'});
  });
export const ownPinSchema=z.object({site_code:z.string().trim().min(1).max(64),pin:z.string().regex(/^\d{4}$/)}).strict();
export const pinSchema = z
  .object({
    site_code: z.string().trim().min(1).max(64),
    user_id: z.number().int().positive(),
    pin: z.string().regex(/^\d{4}$/),
  })
  .strict();
export const revokeSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();
export const commandKey = z.string().trim().min(8).max(160);
export const confirmProgramSchema = scopeSchema
  .extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
