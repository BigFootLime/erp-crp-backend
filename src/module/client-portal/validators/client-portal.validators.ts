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

export type PortalLoginInput = z.infer<typeof portalLoginSchema>;
export type PortalActivateInput = z.infer<typeof portalActivateSchema>;
export type PortalPagination = z.infer<typeof portalPaginationSchema>;
export type AdminCreatePortalAccountInput = z.infer<typeof adminCreatePortalAccountSchema>;
export type AdminPortalAccountStatusInput = z.infer<typeof adminPortalAccountStatusSchema>;
export type AdminCreatePortalPublicationInput = z.infer<typeof adminCreatePortalPublicationSchema>;

