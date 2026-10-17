import type { NextFunction, Request, RequestHandler, Response } from "express";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ capabilities: vi.fn() }));
vi.mock("../../access-control/repository/sensitive-capabilities.repository", () => ({ repoAccountSensitiveCapabilities: mocks.capabilities }));

import {
  requireFinanceCapability,
  requirePaymentAllocationCapabilityForInlineAllocations,
} from "./finance-authorization.middleware";

const authorizePaymentRegistration: RequestHandler[] = [
  requireFinanceCapability("payment_register"),
  requirePaymentAllocationCapabilityForInlineAllocations,
];

function authorizationError(role: string, body: unknown, granted = false): Promise<unknown> {
  mocks.capabilities.mockResolvedValue({ active: true, isSuperadmin: false, capabilities: granted ? ["finance.payment_allocate"] : [] });
  const req = {
    body,
    method: "POST",
    user: { id: 7, username: "finance-test", email: "finance@test.invalid", role, mfa: true, amr: ["pwd", "totp"], mfa_verified_at: Math.floor(Date.now()/1000) },
  } as Request;
  const res = {} as Response;
  return new Promise(resolve => {
  const run = (index: number): void => {
    const handler = authorizePaymentRegistration[index];
    if (!handler) { resolve(undefined); return; }
    handler(req, res, ((nextError?: unknown) => {
      if (nextError) {
        resolve(nextError);
        return;
      }
      run(index + 1);
    }) as NextFunction);
  };

  run(0);
  });
}

describe("#469 inline payment allocation authorization", () => {
  it.each(["Comptable", "Directeur", "Administrateur Systeme et Reseau"])("a module grant and descriptive %s role do not authorize invoice issuance", async role => {
    mocks.capabilities.mockResolvedValue({ active: true, isSuperadmin: false, capabilities: [] });
    const req = {
      method: "POST",
      user: { id: 7, role, mfa: true, amr: ["pwd", "totp"], mfa_verified_at: Math.floor(Date.now()/1000) },
      accountModuleAccess: { userId: 7, moduleKey: "facturation", granted: true, elevated: true },
    } as unknown as Request;
    const result = await new Promise(resolve => requireFinanceCapability("issue")(req, {} as Response, resolve as NextFunction));
    expect(result).toEqual(expect.objectContaining({ status: 403, code: "SENSITIVE_CAPABILITY_REQUIRED" }));
  });

  it("refuse l'allocation sans habilitation nominative", async () => {
    expect(await authorizationError("Secretaire", {
      allocations: [{ target_type: "FACTURE", target_id: "42", amount: "10.00" }],
    })).toEqual(expect.objectContaining({
      status: 403,
      code: "SENSITIVE_CAPABILITY_REQUIRED",
    }));
  });

  it("conserve l'enregistrement sans allocation pour une secrétaire", async () => {
    expect(await authorizationError("Secretaire", { allocations: [] })).toBeUndefined();
  });

  it("autorise le compte explicitement habilité à enregistrer et allouer", async () => {
    expect(await authorizationError("Comptable", {
      allocations: [{ target_type: "FACTURE", target_id: "42", amount: "10.00" }],
    }, true)).toBeUndefined();
  });
});
