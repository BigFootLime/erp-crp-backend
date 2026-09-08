import {z} from "zod";

const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{
  const timestamp=Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(timestamp)&&new Date(timestamp).toISOString().slice(0,10)===v;
},"Date calendaire invalide");
const money=z.number().finite().min(0).max(99_999_999);
const reason=z.string().trim().min(3,"Précisez le motif en trois caractères au moins.").max(2000);
const command={idempotency_key:z.string().trim().min(8).max(120),expected_updated_at:z.string().trim().min(10).max(64)};
const current={...command,consultation_id:z.string().uuid(),expected_version:z.number().int().positive()};

export const supplierOfferResponseSchema=z.object({
  reference:z.string().trim().min(1).max(200),
  currency:z.string().regex(/^[A-Z]{3}$/),
  valid_until:date,
  freight_ht:money,
  payment_terms:z.string().trim().max(200),
  notes:z.string().trim().max(2000),
  lines:z.array(z.object({
    line_id:z.string().uuid(),
    quantity:z.number().finite().positive().max(9_999_999).refine(v=>Math.abs(v*1000-Math.round(v*1000))<0.000001,'Trois décimales au maximum pour une quantité.'),
    unit:z.string().trim().min(1).max(20),
    unit_price_ht:money,
    discount_pct:z.number().finite().min(0).max(100),
    fees_ht:money,
    delivery_date:date,
    conformity:z.enum(['CONFORMING','NONCONFORMING','TO_VERIFY']),
    conformity_notes:z.string().trim().max(2000),
    supplier_reference:z.string().trim().max(120),
  }).strict()).min(1).max(200),
}).strict().superRefine((v,ctx)=>{
  if(new Set(v.lines.map(l=>l.line_id)).size!==v.lines.length)ctx.addIssue({code:z.ZodIssueCode.custom,path:['lines'],message:"Une seule réponse par ligne de besoin est attendue."});
});
export const supplierConsultationCommandSchema=z.discriminatedUnion('action',[
  z.object({...command,action:z.literal('OPEN'),notes:z.string().trim().max(2000)}).strict(),
  z.object({...current,action:z.literal('INVITE'),supplier_id:z.string().uuid(),document_version_ids:z.array(z.string().uuid()).max(50).optional()}).strict(),
  z.object({...current,action:z.literal('RECORD_OFFER'),invitation_id:z.string().uuid(),response:supplierOfferResponseSchema,correction_reason:reason.optional()}).strict(),
  z.object({...current,action:z.literal('SELECT'),offer_id:z.string().uuid(),reason}).strict(),
  z.object({...current,action:z.literal('CLOSE'),reason}).strict(),
]);
export type SupplierOfferResponse=z.infer<typeof supplierOfferResponseSchema>;
export type SupplierConsultationCommand=z.infer<typeof supplierConsultationCommandSchema>;
