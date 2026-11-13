import { describe, expect, it } from "vitest";

import type { CompanyContext } from "./company-context";
import { CompanyContextError } from "./company-context";
import {
  decideCompanyIntercompanyOrder,
  submitCompanyPurchaseOrder,
} from "./intercompany-company-policy";

const EC = "11111111-1111-4111-8111-111111111111";
const CRP = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const PIECE = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";

function context(
  company_id: string,
  module_keys: readonly string[],
  environment: "cerp_prod" | "cerp_test" = "cerp_test",
): CompanyContext {
  return {
    central_account_id: 42,
    directory_profile_id: "77777777-7777-4777-8777-777777777777",
    company_id,
    environment,
    profile: company_id === EC ? "COMMERCIAL" : "INDUSTRIAL",
    workspace: company_id === EC ? "ACCUEIL" : "INDUSTRIAL",
    module_keys,
    commercial_projection_capabilities: [],
  };
}

function purchase(environment: "cerp_prod" | "cerp_test" = "cerp_test") {
  return {
    request_id: REQUEST,
    environment,
    revision: 1,
    buyer: { company_id: EC, namespace: "ESPRIT_CARABINE", active: true },
    supplier: {
      company_id: CRP,
      namespace: "CROIX_ROUSSE_PRECISION",
      active: true,
    },
    relation: {
      buyer_company_id: EC,
      supplier_company_id: CRP,
      active: true,
      supplier_configured: true,
    },
    source_purchase_order_ref: "EC-PO-1",
    source_sales_order_ref: "EC-SO-1",
    commercial_document_issuer_company_id: EC,
    final_delivery_address: {
      recipient_name: "Client",
      address_line_1: "1 rue",
      postal_code: "69001",
      city: "Lyon",
      country_code: "FR",
    },
    lines: [
      {
        source_sales_order_line_ref: "EC-SO-1/1",
        commercial_article_ref: "CROSSE",
        technical_supplier_reference: {
          piece_technique_id: PIECE,
          piece_technique_version_id: VERSION,
        },
        quantity: "1",
        commercial_variant_snapshot: {
          product_label: "Crosse",
          options: { finition: "noir" },
        },
        ec_sale_unit_price: {
          amount: "100",
          currency: "EUR",
          source: "CAPTURED",
        },
        supplier_purchase_unit_price: {
          amount: "80",
          currency: "EUR",
          source: "CAPTURED",
        },
      },
    ],
  };
}

function expectCode(fn: () => unknown, code: string) {
  expect(fn).toThrow(CompanyContextError);
  try {
    fn();
  } catch (error) {
    expect((error as CompanyContextError).code).toBe(code);
  }
}

describe("intercompany company policy", () => {
  const ec = context(EC, ["commandes-fournisseurs"]);
  const crp = context(CRP, ["commandes-clients"]);
  const order = () => submitCompanyPurchaseOrder(ec, purchase());

  it("submits EC purchase orders only from EC purchasing context", () => {
    expect(order().buyer.company_id).toBe(EC);
    expectCode(
      () =>
        submitCompanyPurchaseOrder(
          context(THIRD, ["commandes-fournisseurs"]),
          purchase(),
        ),
      "INTERCOMPANY_BUYER_COMPANY_MISMATCH",
    );
    expectCode(
      () => submitCompanyPurchaseOrder(context(EC, []), purchase()),
      "COMPANY_MODULE_NOT_ALLOWED",
    );
  });

  it("rejects a matching company with the wrong fixed environment", () => {
    expectCode(
      () =>
        submitCompanyPurchaseOrder(
          context(EC, ["commandes-fournisseurs"], "cerp_prod"),
          purchase(),
        ),
      "INTERCOMPANY_ENVIRONMENT_MISMATCH",
    );
    expectCode(
      () =>
        decideCompanyIntercompanyOrder(
          context(CRP, ["commandes-clients"], "cerp_prod"),
          order(),
          { action: "ACCEPT", idempotency_key: "accept-environment-key" },
        ),
      "INTERCOMPANY_ENVIRONMENT_MISMATCH",
    );
  });

  it("rejects a third-company supplier decision and raw actor injection", () => {
    expectCode(
      () =>
        decideCompanyIntercompanyOrder(
          context(THIRD, ["commandes-clients"]),
          order(),
          { action: "ACCEPT", idempotency_key: "accept-third-company" },
        ),
      "INTERCOMPANY_SUPPLIER_SCOPE_DENIED",
    );
    expectCode(
      () =>
        decideCompanyIntercompanyOrder(crp, order(), {
          action: "ACCEPT",
          actor_company_id: THIRD,
          idempotency_key: "accept-client-actor",
        }),
      "INTERCOMPANY_DECISION_INVALID",
    );
  });

  it("prevents EC from accepting supplier actions and enforces module access", () => {
    expectCode(
      () =>
        decideCompanyIntercompanyOrder(ec, order(), {
          action: "ACCEPT",
          idempotency_key: "accept-from-ec-key",
        }),
      "INTERCOMPANY_SUPPLIER_SCOPE_DENIED",
    );
    expectCode(
      () =>
        decideCompanyIntercompanyOrder(context(CRP, []), order(), {
          action: "ACCEPT",
          idempotency_key: "accept-no-module-key",
        }),
      "COMPANY_MODULE_NOT_ALLOWED",
    );
  });

  it("lets CRP accept from its customer-order context and injects its actor company", () => {
    const result = decideCompanyIntercompanyOrder(crp, order(), {
      action: "ACCEPT",
      idempotency_key: "accept-crp-company-key",
    });
    expect(result.order.state).toBe("ACCEPTED");
    expect(result.intent?.customer_company_id).toBe(EC);
    expect(result.intent?.customer_order_owner_company_id).toBe(CRP);
  });
});
