import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { HttpError } from "../../../utils/httpError";
import type { SupplierSandboxIdentity } from "../types/supplier-sandbox.types";
const audience = "cerp-supplier-sandbox",
  issuer = "cerp-api",
  purpose = "supplier-sandbox-session-v1";
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
/** Explicit opt-in, loopback database and exact test database name are all required. */
export function supplierSandboxEnabled() {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.SUPPLIER_PORTAL_SANDBOX !== "1"
  )
    return false;
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
function secret() {
  const value = (process.env.SUPPLIER_PORTAL_SANDBOX_JWT_SECRET ?? "").trim();
  if (!supplierSandboxEnabled() || value.length < 32)
    throw new HttpError(404, "NOT_FOUND", "Introuvable.");
  return value;
}
export const normalizeSupplierSandboxEmail = (v: string) =>
  v.trim().toLocaleLowerCase("fr-FR");
export const requestHash = (v: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(v), "utf8").digest("hex");
export function signSupplierSandboxSession(i: SupplierSandboxIdentity) {
  return jwt.sign(
    {
      purpose,
      account_id: i.accountId,
      supplier_id: i.supplierId,
      session_epoch: i.sessionEpoch,
    },
    secret(),
    {
      algorithm: "HS256",
      audience,
      issuer,
      subject: i.accountId,
      expiresIn: "15m",
    },
  );
}
export function verifySupplierSandboxSession(
  token: string,
): SupplierSandboxIdentity {
  try {
    const d = jwt.verify(token, secret(), {
      algorithms: ["HS256"],
      audience,
      issuer,
    });
    if (
      typeof d !== "object" ||
      !d ||
      d.purpose !== purpose ||
      !uuid(d.account_id) ||
      !uuid(d.supplier_id) ||
      !Number.isSafeInteger(d.session_epoch) ||
      d.session_epoch < 0
    )
      throw new Error("claims");
    return {
      accountId: d.account_id,
      supplierId: d.supplier_id,
      sessionEpoch: d.session_epoch,
    };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(
      401,
      "SUPPLIER_SANDBOX_SESSION_INVALID",
      "Session fournisseur invalide ou expirée.",
    );
  }
}
