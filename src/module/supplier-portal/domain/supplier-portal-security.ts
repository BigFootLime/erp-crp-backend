import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { HttpError } from "../../../utils/httpError";
import type { SupplierPortalIdentity } from "../types/supplier-portal.types";

const audience = "cerp-supplier-portal-pilot",
  issuer = "cerp-api",
  purpose = "supplier-portal-session-v1";
export function supplierPortalPilotEnabled() {
  if (process.env.NODE_ENV === "test") {
    if (process.env.SUPPLIER_PORTAL_PILOT !== "1") return false;
    try {
      const db = new URL(process.env.DATABASE_URL ?? "");
      return (
        ["127.0.0.1", "localhost", "::1"].includes(db.hostname) &&
        db.pathname === "/cerp_test"
      );
    } catch {
      return false;
    }
  }
  return (
    process.env.SUPPLIER_PORTAL_ENABLED === "1" &&
    process.env.SUPPLIER_PORTAL_MODE === "PILOT"
  );
}
function secret() {
  const value = (
    (process.env.NODE_ENV === "test"
      ? process.env.SUPPLIER_PORTAL_PILOT_JWT_SECRET
      : process.env.SUPPLIER_PORTAL_JWT_SECRET) ?? ""
  ).trim();
  if (!supplierPortalPilotEnabled() || value.length < 32)
    throw new HttpError(404, "NOT_FOUND", "Introuvable.");
  return value;
}
export const normalizeSupplierPortalEmail = (email: string) =>
  email.trim().toLocaleLowerCase("fr-FR");
export const opaqueHash = (value: string) =>
  crypto.createHash("sha256").update(value, "utf8").digest("hex");
export const opaqueToken = () => crypto.randomBytes(32).toString("base64url");
export const requestHash = (value: unknown) =>
  opaqueHash(JSON.stringify(value));
export function signSupplierPortalSession(identity: SupplierPortalIdentity) {
  return jwt.sign(
    {
      purpose,
      account_id: identity.accountId,
      supplier_id: identity.supplierId,
      session_epoch: identity.sessionEpoch,
    },
    secret(),
    {
      algorithm: "HS256",
      audience,
      issuer,
      subject: identity.accountId,
      expiresIn: "15m",
    },
  );
}
export function verifySupplierPortalSession(
  token: string,
): SupplierPortalIdentity {
  try {
    const value = jwt.verify(token, secret(), {
      algorithms: ["HS256"],
      audience,
      issuer,
    }) as jwt.JwtPayload;
    if (
      value.purpose !== purpose ||
      typeof value.account_id !== "string" ||
      typeof value.supplier_id !== "string" ||
      !Number.isSafeInteger(value.session_epoch)
    )
      throw new Error("claims");
    return {
      accountId: value.account_id,
      supplierId: value.supplier_id,
      sessionEpoch: value.session_epoch as number,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      401,
      "SUPPLIER_PORTAL_SESSION_INVALID",
      "Session fournisseur invalide ou expirée.",
    );
  }
}
