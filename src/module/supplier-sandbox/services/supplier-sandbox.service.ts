import bcrypt from "bcryptjs";
import { HttpError } from "../../../utils/httpError";
import {
  normalizeSupplierSandboxEmail,
  requestHash,
  signSupplierSandboxSession,
} from "../domain/supplier-sandbox-security";
import * as repo from "../repository/supplier-sandbox.repository";
import type { SupplierSandboxIdentity } from "../types/supplier-sandbox.types";
export async function loginSupplierSandbox(x: {
  email: string;
  password: string;
}) {
  const a = await repo.repoFindSupplierSandboxAccount(
    normalizeSupplierSandboxEmail(x.email),
  );
  if (
    !a ||
    a.status !== "ACTIVE" ||
    !(await bcrypt.compare(x.password, a.password_hash))
  )
    throw new HttpError(
      401,
      "SUPPLIER_SANDBOX_LOGIN_INVALID",
      "Identifiants invalides.",
    );
  const i: SupplierSandboxIdentity = {
    accountId: a.id,
    supplierId: a.supplier_id,
    sessionEpoch: a.session_epoch,
  };
  return {
    token: signSupplierSandboxSession(i),
    supplier_id: i.supplierId,
    expires_in_seconds: 900,
  };
}
export const listSupplierSandboxLines = (i: SupplierSandboxIdentity) =>
  repo.repoListSupplierSandboxLines(i);
export async function submitSupplierSandboxPromise(
  i: SupplierSandboxIdentity,
  x: {
    order_id: string;
    line_id: string;
    promised_date: string;
    promised_quantity: number;
    reason: string;
  },
  key: string,
) {
  if (
    new Date(`${x.promised_date}T00:00:00Z`).getTime() <
    Date.now() - 86400000
  )
    throw new HttpError(
      400,
      "SUPPLIER_SANDBOX_DATE",
      "La date promise ne peut pas être passée.",
    );
  try {
    return await repo.repoCreateSupplierSandboxProposal({
      identity: i,
      orderId: x.order_id,
      lineId: x.line_id,
      promisedDate: x.promised_date,
      promisedQuantity: x.promised_quantity,
      reason: x.reason,
      idempotencyKey: key,
      requestHash: requestHash(x),
    });
  } catch (e: any) {
    if (e?.code === "SUPPLIER_LINE_NOT_FOUND")
      throw new HttpError(
        404,
        "SUPPLIER_SANDBOX_LINE_NOT_FOUND",
        "Ligne introuvable.",
      );
    if (e?.code === "SUPPLIER_SANDBOX_IDEMPOTENCY_PAYLOAD_MISMATCH")
      throw new HttpError(
        409,
        "SUPPLIER_SANDBOX_IDEMPOTENCY_PAYLOAD_MISMATCH",
        "Cette clé d’idempotence a déjà servi avec une demande différente.",
      );
    throw e;
  }
}
