import { z } from "zod";

const uuid = z.string().uuid();
const email = z.string().trim().email().max(254);
const password = z.string().min(12).max(128)
  .regex(/[A-Z]/, "Une majuscule est requise.")
  .regex(/[a-z]/, "Une minuscule est requise.")
  .regex(/[0-9]/, "Un chiffre est requis.")
  .regex(/[^A-Za-z0-9]/, "Un symbole est requis.");

export const portalLoginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
}).strict();

export const portalForgotPasswordSchema = z.object({ email }).strict();

export const portalActivateSchema = z.object({
  token: z.string().trim().min(32).max(4096),
  password,
}).strict();

export const portalResetPasswordSchema = portalActivateSchema;

export const portalPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const portalUuidParamSchema = uuid;

export const adminCreatePortalAccountSchema = z.object({
  client_id: z.string().trim().min(1).max(3),
  email,
  display_name: z.string().trim().min(2).max(120),
}).strict();

export const adminPortalAccountStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const adminCreatePortalPublicationSchema = z.object({
  client_id: z.string().trim().min(1).max(3),
  version_id: uuid,
  title: z.string().trim().min(2).max(180).optional().nullable(),
  expires_at: z.string().datetime({ offset: true }).optional().nullable(),
  acknowledgement_required: z.boolean().default(false),
}).strict();

export const adminRevokePortalPublicationSchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();

export const idempotencyKeySchema = z.string().uuid();
export const portalDeliveryReceiptSchema = z.object({
  delivered_at: z.string().datetime({ offset: true }),
  received_by_name: z.string().trim().min(1).max(200).optional().nullable(),
  note: z.string().trim().min(1).max(2000).optional().nullable(),
  line_receipts: z.array(z.object({ delivery_line_id: uuid, delivery_allocation_id: uuid.optional(), quantity_received: z.coerce.number().positive().max(1_000_000_000) }).strict()).min(1).max(500),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.line_receipts.forEach((line, index) => {
    if (seen.has(line.delivery_line_id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["line_receipts", index, "delivery_line_id"], message: "Une ligne de livraison ne peut être confirmée qu'une fois." });
    seen.add(line.delivery_line_id);
  });
});
export const portalDeliveryDashboardQuerySchema=z.object({from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict().refine(v=>v.from<=v.to,{message:"Période invalide"});
export const adminPortalDeliverySiteBindingSchema=z.object({delivery_address_id:uuid}).strict();
export const adminPortalContractBindingSchema=z.object({contract_id:uuid}).strict();
export const adminPortalOperationalNoticeSchema=z.object({
  client_id:z.string().trim().min(1).max(3), account_id:uuid.optional().nullable(), delivery_address_id:uuid.optional().nullable(),
  notice_type:z.enum(["FERMETURE","INVENTAIRE"]), title:z.string().trim().min(3).max(160), message:z.string().trim().min(3).max(500),
  published_from:z.string().datetime({offset:true}), published_until:z.string().datetime({offset:true}), starts_on:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(), ends_on:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
}).strict().refine(value=>value.published_until>value.published_from,{message:"Période de publication invalide"}).refine(value=>!value.starts_on||!value.ends_on||value.ends_on>=value.starts_on,{message:"Période opérationnelle invalide"});
/** Explicit allow-list for imports and demand visibility; default remains deny. */
export const adminPortalDemandSiteBindingSchema=z.object({external_site:z.string().trim().min(1).max(80)}).strict();

export type PortalLoginInput = z.infer<typeof portalLoginSchema>;
export type PortalActivateInput = z.infer<typeof portalActivateSchema>;
export type PortalPagination = z.infer<typeof portalPaginationSchema>;
export type AdminCreatePortalAccountInput = z.infer<typeof adminCreatePortalAccountSchema>;
export type AdminPortalAccountStatusInput = z.infer<typeof adminPortalAccountStatusSchema>;
export type AdminCreatePortalPublicationInput = z.infer<typeof adminCreatePortalPublicationSchema>;

