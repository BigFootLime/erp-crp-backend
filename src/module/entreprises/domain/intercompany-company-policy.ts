import { z } from "zod";

import {
  type CompanyContext,
  CompanyContextError,
  assertCompanyModuleAccess,
} from "./company-context";
import {
  type IntercompanyDecisionResult,
  type IntercompanyOrder,
  createIntercompanyPurchaseOrder,
  decideIntercompanyOrder,
  intercompanyDecisionSchema,
  intercompanyPurchaseOrderInputSchema,
} from "./intercompany-order";

/**
 * This layer receives a CompanyContext already resolved by server-side central
 * authentication/session validation. It performs no network call or storage.
 */
export const companyIntercompanyDecisionSchema = intercompanyDecisionSchema
  .omit({ actor_company_id: true })
  .strict();

function policyError(code: string, message: string): never {
  throw new CompanyContextError(code, message);
}

function parseDecisionCommand(
  raw: unknown,
): z.infer<typeof companyIntercompanyDecisionSchema> {
  const parsed = companyIntercompanyDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    policyError(
      "INTERCOMPANY_DECISION_INVALID",
      "The intercompany decision command is invalid.",
    );
  }
  return parsed.data;
}

function assertOrderEnvironment(
  context: CompanyContext,
  order: Pick<IntercompanyOrder, "environment">,
): void {
  if (order.environment !== context.environment) {
    policyError(
      "INTERCOMPANY_ENVIRONMENT_MISMATCH",
      "The intercompany order environment does not match the active company context.",
    );
  }
}

/** EC submits its purchase order only from its own resolved company context. */
export function submitCompanyPurchaseOrder(
  context: CompanyContext,
  raw: unknown,
): IntercompanyOrder {
  assertCompanyModuleAccess(context, "commandes-fournisseurs");
  const input = intercompanyPurchaseOrderInputSchema.parse(raw);
  if (input.environment !== context.environment) {
    policyError(
      "INTERCOMPANY_ENVIRONMENT_MISMATCH",
      "The purchase order environment does not match the active company context.",
    );
  }
  if (input.buyer.company_id !== context.company_id) {
    policyError(
      "INTERCOMPANY_BUYER_COMPANY_MISMATCH",
      "The purchase order buyer must be the active company.",
    );
  }
  return createIntercompanyPurchaseOrder(input);
}

/**
 * Decides a scoped order and injects the actor company only after the server
 * context and order scope have been checked. A client cannot name an actor.
 */
export function decideCompanyIntercompanyOrder(
  context: CompanyContext,
  order: IntercompanyOrder,
  rawCommand: unknown,
): IntercompanyDecisionResult {
  assertOrderEnvironment(context, order);
  const command = parseDecisionCommand(rawCommand);
  const supplierAction = [
    "ACCEPT",
    "REJECT",
    "CONFIRM_CANCEL",
    "REJECT_CANCEL",
  ] as const;

  if (
    supplierAction.includes(command.action as (typeof supplierAction)[number])
  ) {
    if (order.supplier.company_id !== context.company_id) {
      policyError(
        "INTERCOMPANY_SUPPLIER_SCOPE_DENIED",
        "Only the supplier company may decide this supplier action.",
      );
    }
    assertCompanyModuleAccess(context, "commandes-clients");
  } else {
    if (order.buyer.company_id !== context.company_id) {
      policyError(
        "INTERCOMPANY_BUYER_SCOPE_DENIED",
        "Only the buyer company may request cancellation.",
      );
    }
    assertCompanyModuleAccess(context, "commandes-fournisseurs");
  }

  return decideIntercompanyOrder(order, {
    ...command,
    actor_company_id: context.company_id,
  });
}
