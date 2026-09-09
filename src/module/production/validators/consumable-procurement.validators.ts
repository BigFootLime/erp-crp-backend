import { z } from 'zod';
import { consumableQuantitySchema } from '../../stock/domain/consumable-quantity';

const command = { idempotencyKey:z.string().uuid(), expectedVersion:z.string().min(1).max(128) };
export const consumableConfigurationSchema=z.object({...command,sourceRef:z.string().uuid(),supplierId:z.string().uuid().nullable(),destinationId:z.string().uuid().nullable()}).strict();
export const consumablePreparationSchema=z.object({...command,
  needs:z.array(z.object({key:z.string().uuid(),reserve:z.boolean(),purchase:z.boolean(),
    existingPurchasesReviewed:z.boolean().default(false),
    future:z.array(z.object({lineId:z.string().uuid(),quantity:consumableQuantitySchema}).strict()).max(200).default([])
  }).strict()).min(1).max(200)
}).strict().superRefine((b,ctx)=>{if(new Set(b.needs.map(n=>n.key)).size!==b.needs.length)ctx.addIssue({code:'custom',path:['needs'],message:'Un besoin ne peut être sélectionné deux fois.'});});
export const consumableWithdrawalSchema=z.object({...command,reservationId:z.string().uuid(),reservationVersion:z.number().int().positive(),scan:z.string().trim().min(1).max(255),quantity:consumableQuantitySchema,reason:z.string().trim().min(1).max(1000)}).strict();
export const consumableReconciliationSchema=z.object({...command,previousNeedId:z.string().uuid(),targetKey:z.string().uuid().nullable(),disposition:z.enum(['CARRY','KEEP_SEPARATE']),reason:z.string().trim().min(10).max(2000)}).strict();
export type ConsumablePreparation=z.infer<typeof consumablePreparationSchema>;
export type ConsumableConfiguration=z.infer<typeof consumableConfigurationSchema>;
export type ConsumableWithdrawal=z.infer<typeof consumableWithdrawalSchema>;
export type ConsumableReconciliation=z.infer<typeof consumableReconciliationSchema>;
