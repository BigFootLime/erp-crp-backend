import { describe, expect, it } from "vitest";
import {
  commercialCustomerDisplayName,
  commercialCustomerIdentitySchema,
  planWebOrderIntake,
} from "./web-order-intake";

const buyer = "10000000-0000-4000-8000-000000000001";
const supplier = "10000000-0000-4000-8000-000000000002";
const connector = () => ({
  connector_id: "10000000-0000-4000-8000-000000000003",
  environment: "cerp_test",
  buyer_company_id: buyer,
  supplier_company_id: supplier,
  status: "ACTIVE",
});
const event = () => ({
  contract_version: 1,
  external_order_id: "SHOP-42",
  external_order_revision: 1,
  state: "CONFIRMED",
  confirmed_at: "2026-10-26T14:00:00+01:00",
  customer: { type: "INDIVIDUAL", first_name: "Client", last_name: "Test" },
  delivery_address: {
    recipient_name: "Client Test",
    address_line_1: "1 rue du Test",
    city: "Lyon",
    postal_code: "69001",
    country_code: "FR",
  },
  lines: [
    {
      external_line_id: "line-1",
      commercial_article_ref: "ARTICLE-TEST",
      catalogue_binding_id: "10000000-0000-4000-8000-000000000004",
      catalogue_binding_revision: 1,
      quantity: "2",
      sale_unit_price: { amount: "100.00", currency: "EUR" },
    },
  ],
});

describe("future shop intake contract", () => {
  it("automatically prepares the EC purchase after confirmation, retaining supplier approval", () => {
    const result = planWebOrderIntake(connector(), event());
    expect(result.disposition).toBe("CREATE_EC_ORDER_AND_PURCHASE");
    if (result.disposition !== "CREATE_EC_ORDER_AND_PURCHASE")
      throw new Error("Expected purchase intent");
    expect(result.purchase_intent).toMatchObject({
      buyer_company_id: buyer,
      supplier_company_id: supplier,
      manual_buyer_approval_required: false,
      supplier_approval_required: true,
    });
    expect(result.purchase_intent).not.toHaveProperty("sale_unit_price");
    expect(result.purchase_intent).not.toHaveProperty("customer");
    expect(result.purchase_intent).not.toHaveProperty("delivery_address");
    expect(Object.isFrozen(result.order.lines[0])).toBe(true);
  });

  it.each(["DRAFT", "CANCELLED"])(
    "never creates an automatic purchase for %s",
    (state) => {
      expect(
        planWebOrderIntake(connector(), { ...event(), state }).disposition,
      ).toBe("NO_PURCHASE");
    },
  );

  it("does not impose a made-up payment condition beyond the confirmed order", () => {
    expect(() => planWebOrderIntake(connector(), event())).not.toThrow();
    expect(() =>
      planWebOrderIntake(connector(), { ...event(), confirmed_at: undefined }),
    ).toThrow();
  });

  it("deduplicates confirmation and requires an amendment instead of ordering twice", () => {
    const first = planWebOrderIntake(connector(), event());
    expect(
      planWebOrderIntake(connector(), event(), first.receipt).disposition,
    ).toBe("REPLAY");
    const updated = planWebOrderIntake(
      connector(),
      { ...event(), external_order_revision: 2 },
      first.receipt,
    );
    expect(updated.disposition).toBe("AMENDMENT_REQUIRED");
    expect(updated.receipt.source_key).toBe(first.receipt.source_key);
  });

  it("treats changes of lines, prices and delivery address as amendments", () => {
    const first = planWebOrderIntake(connector(), event());
    const changes = [
      { lines: [{ ...event().lines[0], quantity: "3" }] },
      {
        lines: [
          {
            ...event().lines[0],
            sale_unit_price: { amount: "99.00", currency: "EUR" },
          },
        ],
      },
      { delivery_address: { ...event().delivery_address, city: "Paris" } },
    ];
    for (const change of changes)
      expect(
        planWebOrderIntake(
          connector(),
          { ...event(), ...change, external_order_revision: 2 },
          first.receipt,
        ).disposition,
      ).toBe("AMENDMENT_REQUIRED");
  });

  it("routes cancellation after purchase to a tracked request and forbids reopening", () => {
    const first = planWebOrderIntake(connector(), event());
    const cancelled = planWebOrderIntake(
      connector(),
      { ...event(), state: "CANCELLED", external_order_revision: 2 },
      first.receipt,
    );
    expect(cancelled.disposition).toBe("CANCELLATION_REQUIRED");
    expect(cancelled.receipt.purchase_requested).toBe(true);
    expect(
      planWebOrderIntake(
        connector(),
        { ...event(), state: "CANCELLED", external_order_revision: 2 },
        cancelled.receipt,
      ).disposition,
    ).toBe("REPLAY");
    expect(() =>
      planWebOrderIntake(
        connector(),
        { ...event(), external_order_revision: 3 },
        cancelled.receipt,
      ),
    ).toThrow("WEB_ORDER_TERMINAL_STATE");
    expect(() =>
      planWebOrderIntake(
        connector(),
        { ...event(), state: "DRAFT", external_order_revision: 2 },
        first.receipt,
      ),
    ).toThrow("WEB_ORDER_STATE_REGRESSION");
  });

  it("processes confirmation after a draft without losing the automatic purchase", () => {
    const draft = planWebOrderIntake(connector(), {
      ...event(),
      state: "DRAFT",
    });
    expect(draft.receipt.purchase_requested).toBe(false);
    expect(
      planWebOrderIntake(
        connector(),
        { ...event(), external_order_revision: 2 },
        draft.receipt,
      ).disposition,
    ).toBe("CREATE_EC_ORDER_AND_PURCHASE");
  });

  it("does not roll back a newer processed revision or reuse a revision for another payload", () => {
    const newer = planWebOrderIntake(connector(), {
      ...event(),
      external_order_revision: 3,
    });
    const stale = planWebOrderIntake(connector(), event(), newer.receipt);
    expect(stale.disposition).toBe("STALE");
    expect(stale.receipt).toEqual(newer.receipt);
    expect(() =>
      planWebOrderIntake(
        connector(),
        {
          ...event(),
          external_order_revision: 3,
          confirmed_at: "2026-10-26T15:00:00+01:00",
        },
        newer.receipt,
      ),
    ).toThrow("WEB_ORDER_REVISION_CONFLICT");
  });

  it("refuses silently moving an existing purchase to another supplier", () => {
    const first = planWebOrderIntake(connector(), event());
    expect(() =>
      planWebOrderIntake(
        {
          ...connector(),
          supplier_company_id: "10000000-0000-4000-8000-000000000007",
        },
        { ...event(), external_order_revision: 2 },
        first.receipt,
      ),
    ).toThrow("WEB_ORDER_SUPPLIER_BINDING_CHANGED");
  });

  it("scopes equal external order IDs by company, connector and environment", () => {
    const first = planWebOrderIntake(connector(), event());
    for (const change of [
      { environment: "cerp_prod" },
      { buyer_company_id: "10000000-0000-4000-8000-000000000005" },
      { connector_id: "10000000-0000-4000-8000-000000000006" },
    ]) {
      const different = planWebOrderIntake(
        { ...connector(), ...change },
        event(),
      );
      expect(different.receipt.source_key).not.toBe(first.receipt.source_key);
      expect(() =>
        planWebOrderIntake(
          { ...connector(), ...change },
          event(),
          first.receipt,
        ),
      ).toThrow("WEB_ORDER_RECEIPT_SCOPE_MISMATCH");
    }
  });

  it("cannot select the company through a shop payload or use a disabled connector", () => {
    expect(() =>
      planWebOrderIntake(connector(), { ...event(), company_id: supplier }),
    ).toThrow();
    expect(() =>
      planWebOrderIntake({ ...connector(), status: "DISABLED" }, event()),
    ).toThrow("WEB_ORDER_CONNECTOR_DISABLED");
    expect(() =>
      planWebOrderIntake(
        { ...connector(), buyer_company_id: supplier },
        event(),
      ),
    ).toThrow();
  });

  it("rejects invalid quantities, duplicate lines and invented technical details", () => {
    for (const quantity of [
      "0",
      "-1",
      "Infinity",
      "1e3",
      "99999999999999999999",
      "0.0000001",
    ]) {
      expect(() =>
        planWebOrderIntake(connector(), {
          ...event(),
          lines: [{ ...event().lines[0], quantity }],
        }),
      ).toThrow();
    }
    expect(() =>
      planWebOrderIntake(connector(), {
        ...event(),
        lines: [event().lines[0], event().lines[0]],
      }),
    ).toThrow();
    expect(() =>
      planWebOrderIntake(connector(), {
        ...event(),
        lines: [{ ...event().lines[0], technical_dossier: {} }],
      }),
    ).toThrow();
  });
});

describe("commercial customer identity", () => {
  it("accepts an individual without inventing a company or registration number", () => {
    expect(
      commercialCustomerDisplayName({
        type: "INDIVIDUAL",
        first_name: " Client ",
        last_name: " Test ",
      }),
    ).toBe("Client Test");
    expect(
      commercialCustomerIdentitySchema.safeParse({
        type: "INDIVIDUAL",
        first_name: "Client",
        last_name: "Test",
        legal_name: "Invented",
      }).success,
    ).toBe(false);
  });
  it("supports a professional customer without treating a contact as the legal entity", () => {
    expect(
      commercialCustomerDisplayName({
        type: "PROFESSIONAL",
        legal_name: "Entreprise de test",
      }),
    ).toBe("Entreprise de test");
    expect(
      commercialCustomerIdentitySchema.safeParse({
        type: "PROFESSIONAL",
        first_name: "Client",
        last_name: "Test",
      }).success,
    ).toBe(false);
  });
  it("requires explicit type and nonblank identity", () => {
    expect(
      commercialCustomerIdentitySchema.safeParse({
        first_name: "Client",
        last_name: "Test",
      }).success,
    ).toBe(false);
    expect(
      commercialCustomerIdentitySchema.safeParse({
        type: "INDIVIDUAL",
        first_name: " ",
        last_name: "Test",
      }).success,
    ).toBe(false);
  });
});
