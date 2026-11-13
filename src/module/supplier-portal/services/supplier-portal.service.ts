import bcrypt from "bcryptjs";
import { buildPortalUrl } from "../../client-portal/services/client-portal-email.service";
import { HttpError } from "../../../utils/httpError";
import {
  normalizeSupplierPortalEmail,
  opaqueToken,
  requestHash,
  signSupplierPortalSession,
} from "../domain/supplier-portal-security";
import * as repo from "../repository/supplier-portal.repository";
import type { SupplierPortalIdentity } from "../types/supplier-portal.types";
const expiry = () => new Date(Date.now() + 24 * 3600_000).toISOString();
export async function login(input: { email: string; password: string }) {
  const a = await repo.findAccountByEmail(
    normalizeSupplierPortalEmail(input.email),
  );
  if (
    !a ||
    a.account_status !== "ACTIVE" ||
    !a.password_hash ||
    !(await bcrypt.compare(input.password, a.password_hash))
  )
    throw new HttpError(
      401,
      "SUPPLIER_PORTAL_LOGIN_INVALID",
      "Identifiants invalides.",
    );
  const identity = {
    accountId: a.id,
    supplierId: a.supplier_id,
    sessionEpoch: a.session_epoch,
  };
  return {
    token: signSupplierPortalSession(identity),
    expires_in_seconds: 900,
  };
}
export async function activate(input: {
  token: string;
  password: string;
  consent: boolean;
}) {
  const account = await repo.consumeTokenAndSetPassword({
    token: input.token,
    kind: "ACTIVATE",
    passwordHash: await bcrypt.hash(input.password, 12),
    consent: input.consent,
  });
  return {
    token: signSupplierPortalSession({
      accountId: account.id,
      supplierId: account.supplier_id,
      sessionEpoch: account.session_epoch,
    }),
    expires_in_seconds: 900,
  };
}
export async function reset(input: { token: string; password: string }) {
  const account = await repo.consumeTokenAndSetPassword({
    token: input.token,
    kind: "RESET",
    passwordHash: await bcrypt.hash(input.password, 12),
    consent: false,
  });
  return {
    token: signSupplierPortalSession({
      accountId: account.id,
      supplierId: account.supplier_id,
      sessionEpoch: account.session_epoch,
    }),
    expires_in_seconds: 900,
  };
}
export async function recover(email: string) {
  const account = await repo.findAccountByEmail(
    normalizeSupplierPortalEmail(email),
  );
  if (account?.account_status === "ACTIVE")
    await repo.markRecoveryRequested(account.email_normalized);
  return { accepted: true };
}
export const context = async (identity: SupplierPortalIdentity) => ({
  supplier_id: identity.supplierId,
  mode: "PILOT_ISOLATED",
  promises: "REVIEW_ONLY",
  policy_version: await repo.configuredSupplierPortalPolicyVersion(
    identity.supplierId,
  ),
});
export const orders = (identity: SupplierPortalIdentity) =>
  repo.listPortalOrders(identity);
export const promise = (
  identity: SupplierPortalIdentity,
  input: {
    orderId: string;
    lineId: string;
    date: string;
    quantity: number;
    reason: string;
    version: string;
    key: string;
    estimatedReturn: string | null;
    estimateReason: string | null;
  },
) =>
  repo.createPromiseReview({
    identity,
    orderId: input.orderId,
    lineId: input.lineId,
    date: input.date,
    quantity: input.quantity,
    reason: input.reason,
    version: input.version,
    key: input.key,
    estimatedReturn: input.estimatedReturn,
    estimateReason: input.estimateReason,
    hash: requestHash(input),
  });
export async function invite(input: {
  supplierId: string;
  email: string;
  orderIds: string[];
  expiresAt: string;
}) {
  if (Date.parse(input.expiresAt) <= Date.now())
    throw new HttpError(
      400,
      "SUPPLIER_PORTAL_INVITE_EXPIRY",
      "L’expiration doit être future.",
    );
  if (!(await repo.isConfiguredPilotSupplier(input.supplierId)))
    throw new HttpError(
      409,
      "SUPPLIER_PORTAL_SUPPLIER_NOT_PILOT",
      "Le fournisseur n’est pas le pilote approuvé.",
    );
  const raw = opaqueToken(),
    saved = await repo.invite({
      ...input,
      email: normalizeSupplierPortalEmail(input.email),
      token: raw,
    });
  const manualUrl = "/supplier-portal/activate?token=" + encodeURIComponent(raw);
  return {
    invite_id: saved.id,
    manual_url: manualUrl,
    public_url: buildPortalUrl(manualUrl, process.env.SUPPLIER_PORTAL_PUBLIC_URL),
    expires_at: saved.expires_at,
    status: saved.status,
  };
}
export async function resetByAdmin(accountId: string) {
  const raw = opaqueToken(),
    saved = await repo.resetByAdmin(accountId, raw, expiry());
  const manualUrl = "/supplier-portal/reset?token=" + encodeURIComponent(raw);
  return {
    manual_url: manualUrl,
    public_url: buildPortalUrl(manualUrl, process.env.SUPPLIER_PORTAL_PUBLIC_URL),
    expires_at: saved.expires_at,
  };
}
export const access = () => repo.listAdminAccess();
export const disable = (id: string) => repo.disableAccount(id);
export const reviews = () => repo.listPromiseReviews();
export const decide = (
  id: string,
  decision: "ACCEPT" | "REJECT",
  note: string,
  actor: number,
  key: string,
) => repo.decideReview(id, decision, note, actor, key);
