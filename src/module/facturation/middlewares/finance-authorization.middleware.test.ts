import type { NextFunction, Request, RequestHandler, Response } from "express";
import { describe, expect, it } from "vitest";

import {
  requireFinanceCapability,
  requirePaymentAllocationCapabilityForInlineAllocations,
} from "./finance-authorization.middleware";

const authorizePaymentRegistration: RequestHandler[] = [
  requireFinanceCapability("payment_register"),
  requirePaymentAllocationCapabilityForInlineAllocations,
];

function authorizationError(role: string, body: unknown): unknown {
  const req = {
    body,
    user: { id: 7, username: "finance-test", email: "finance@test.invalid", role },
  } as Request;
  const res = {} as Response;
  let error: unknown;

  const run = (index: number): void => {
    const handler = authorizePaymentRegistration[index];
    if (!handler) return;
    handler(req, res, ((nextError?: unknown) => {
      if (nextError) {
        error = nextError;
        return;
      }
      run(index + 1);
    }) as NextFunction);
  };

  run(0);
  return error;
}

describe("#469 inline payment allocation authorization", () => {
  it("refuse à une secrétaire l'enregistrement qui alloue dans la même commande", () => {
    expect(authorizationError("Secretaire", {
      allocations: [{ target_type: "FACTURE", target_id: "42", amount: "10.00" }],
    })).toEqual(expect.objectContaining({
      status: 403,
      code: "FINANCE_CAPABILITY_REQUIRED",
    }));
  });

  it("conserve l'enregistrement sans allocation pour une secrétaire", () => {
    expect(authorizationError("Secretaire", { allocations: [] })).toBeUndefined();
  });

  it("autorise un comptable à enregistrer et allouer dans la même commande", () => {
    expect(authorizationError("Comptable", {
      allocations: [{ target_type: "FACTURE", target_id: "42", amount: "10.00" }],
    })).toBeUndefined();
  });
});
