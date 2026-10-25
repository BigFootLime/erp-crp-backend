import { z } from "zod";

import { canonicalizeAuthEmail, canonicalizeAuthUsername } from "../../auth/domain/auth-identity";
import { ASSIGNABLE_USER_ROLES, PRIMARY_USER_ROLES } from "../../auth/domain/roles";
import { strongPasswordReset, strictEmail } from "../../auth/validators/_helpers";
import { AVATAR_KEYS } from "../../auth/validators/test-registration.validator";

const personName = z.string().trim().min(2).max(80);
const requestId = z.string().guid();
const version = z.number().int().min(0);
const moduleKey = z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/);

export const submitAccountRequestSchema = z.object({
  body: z.object({
    name: personName,
    surname: personName.refine((value) => {
      try { usernameBaseFromGivenName(value); return true; } catch { return false; }
    }, "Le prénom doit permettre un identifiant de 2 à 50 caractères."),
    email: strictEmail.transform(canonicalizeAuthEmail),
    password: strongPasswordReset.refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Mot de passe trop long"),
    avatar_key: z.enum(AVATAR_KEYS),
  }).strict(),
});

export const accountRequestStatusSchema = z.object({
  headers: z.object({ receipt: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
});

export const listAccountRequestsSchema = z.object({
  query: z.object({
    status: z.enum(["PENDING", "PROJECTION_PENDING", "APPROVED", "REJECTED", "EXPIRED"]).optional().default("PENDING"),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    cursor: z.string().guid().optional(),
  }).strict(),
});

export const approveAccountRequestSchema = z.object({
  params: z.object({ id: requestId }),
  headers: z.object({ idempotencyKey: z.string().guid() }),
  body: z.object({
    expected_version: version,
    primary_role: z.enum(PRIMARY_USER_ROLES),
    roles: z.array(z.enum(ASSIGNABLE_USER_ROLES)).min(1).max(ASSIGNABLE_USER_ROLES.length),
    administrative_kind: z.enum(["STANDARD", "BUSINESS_ADMIN"]),
    module_keys: z.array(moduleKey).max(100).refine((values) => new Set(values).size === values.length, "Modules dupliqués"),
    link_historical_user_id: z.number().int().positive().nullable().optional(),
  }).strict().superRefine((value, ctx) => {
    if (!value.roles.includes(value.primary_role)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles"], message: "Le rôle principal doit figurer parmi les rôles." });
    }
  }),
});

export const rejectAccountRequestSchema = z.object({
  params: z.object({ id: requestId }),
  headers: z.object({ idempotencyKey: z.string().guid() }),
  body: z.object({ expected_version: version, reason: z.string().trim().max(500).optional() }).strict(),
});

export const deleteAccountRequestSchema = z.object({
  params: z.object({ id: requestId }),
  headers: z.object({ idempotencyKey: z.string().guid() }),
  body: z.object({ expected_version: version }).strict(),
});

export function usernameBaseFromGivenName(value: string): string {
  const canonical = canonicalizeAuthUsername(value.normalize('NFD').replace(/\p{M}/gu, '')).replace(/[^A-Z0-9._-]/g, "");
  if (canonical.length < 2 || canonical.length > 50) throw new Error("ACCOUNT_REQUEST_USERNAME_BASE_INVALID");
  return canonical;
}
