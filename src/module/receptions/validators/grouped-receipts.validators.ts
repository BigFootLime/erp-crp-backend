import { z } from 'zod';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const expectedReceiptsQuerySchema=z.object({q:z.string().trim().max(200).optional(),orderId:z.string().uuid().optional(),orderCode:z.string().trim().max(100).optional(),supplierId:z.string().uuid().optional(),supplierName:z.string().trim().max(150).optional(),category:z.string().trim().max(60).optional(),ofId:z.coerce.number().int().positive().optional(),ofNumber:z.string().trim().max(100).optional(),dateFrom:date.optional(),dateTo:date.optional(),partial:z.enum(['true','false']).optional(),page:z.coerce.number().int().positive().default(1),pageSize:z.coerce.number().int().min(1).max(100).default(30)});
export const prepareGroupedReceiptSchema=z.object({idempotencyKey:z.string().uuid(),supplierId:z.string().uuid(),reference:z.string().trim().min(1).max(120),date}).strict();
const quantity=z.number().positive().max(999999999).refine(v=>Math.abs(v*1000-Math.round(v*1000))<0.000001,'Trois décimales maximum.');
const destination=z.object({magasinId:z.string().uuid(),emplacementId:z.number().int().positive()});
export const confirmGroupedReceiptSchema=z.object({idempotencyKey:z.string().uuid(),
  lines:z.array(z.object({lineId:z.string().uuid(),expectedVersion:z.string().min(1),quantity,destination:destination.nullable(),supplierLotCode:z.string().trim().max(120).nullable(),
    packs:z.array(z.object({quantity,supplierLotCode:z.string().trim().max(120).nullable()})).max(200).default([]),overReceiptReason:z.string().trim().max(1000).nullable()
  }).strict()).min(1).max(100)
}).strict().superRefine((body,ctx)=>{
  if(new Set(body.lines.map(l=>l.lineId)).size!==body.lines.length)ctx.addIssue({code:'custom',path:['lines'],message:'Une ligne de commande ne peut être sélectionnée deux fois.'});
  body.lines.forEach((l,index)=>{if(l.packs.length&&Math.abs(l.packs.reduce((sum,p)=>sum+p.quantity,0)-l.quantity)>0.000001)ctx.addIssue({code:'custom',path:['lines',index,'packs'],message:'Le total des conditionnements doit correspondre à la quantité livrée.'});});
});
export type ExpectedReceiptsQuery=z.infer<typeof expectedReceiptsQuerySchema>;
export type PrepareGroupedReceipt=z.infer<typeof prepareGroupedReceiptSchema>;
export type ConfirmGroupedReceipt=z.infer<typeof confirmGroupedReceiptSchema>;
