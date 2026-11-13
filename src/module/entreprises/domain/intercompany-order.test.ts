import { describe, expect, it } from "vitest";
import {
  applySupplierFulfilment,
  createIntercompanyPurchaseOrder,
  decideIntercompanyOrder,
  receiptForIntercompanyDecision,
  resolveIntercompanyDecisionIdempotency,
  sha256Canonical,
} from "./intercompany-order";
const b = "11111111-1111-4111-8111-111111111111",
  s = "22222222-2222-4222-8222-222222222222",
  t = "33333333-3333-4333-8333-333333333333",
  r = "44444444-4444-4444-8444-444444444444",
  p = "55555555-5555-4555-8555-555555555555",
  v = "66666666-6666-4666-8666-666666666666";
const input = () => ({
  request_id: r,
  environment: "cerp_test",
  revision: 1,
  buyer: { company_id: b, namespace: "ESPRIT_CARABINE", active: true },
  supplier: {
    company_id: s,
    namespace: "CROIX_ROUSSE_PRECISION",
    active: true,
  },
  relation: {
    buyer_company_id: b,
    supplier_company_id: s,
    active: true,
    supplier_configured: true,
  },
  source_purchase_order_ref: " EC-PO-1 ",
  source_sales_order_ref: "EC-SO-1",
  commercial_document_issuer_company_id: b,
  final_delivery_address: {
    recipient_name: "Final",
    address_line_1: "1 rue",
    postal_code: "69001",
    city: "Lyon",
    country_code: "fr",
  },
  lines: [
    {
      source_sales_order_line_ref: "EC-SO-1/1",
      commercial_article_ref: "CROSSE",
      technical_supplier_reference: {
        piece_technique_id: p,
        piece_technique_version_id: v,
      },
      quantity: "2.5",
      commercial_variant_snapshot: {
        product_label: "Crosse",
        options: { color: "black" },
      },
      ec_sale_unit_price: {
        amount: "100",
        currency: "EUR",
        source: "CAPTURED",
      },
      supplier_purchase_unit_price: {
        amount: "100",
        currency: "USD",
        source: "CAPTURED",
      },
    },
  ],
});
const accepted = () =>
  decideIntercompanyOrder(createIntercompanyPurchaseOrder(input()), {
    action: "ACCEPT",
    actor_company_id: s,
    idempotency_key: "accept-request-44444444",
  }).order;
describe("intercompany order", () => {
  it("rejects unknown inherited line names and empty shipment payloads", () => {
    for (const quantities_by_source_line of [{}, { toString: "1" }]) {
      expect(() =>
        applySupplierFulfilment(accepted(), {
          shipment_id: "UNKNOWN",
          idempotency_key: "unknown-line-shipment-key",
          actor_company_id: s,
          quantities_by_source_line,
        }),
      ).toThrow();
    }
  });

  it("handles a real external line named constructor without inherited totals", () => {
    const order = createIntercompanyPurchaseOrder({
      ...input(),
      lines: [
        { ...input().lines[0], source_sales_order_line_ref: "constructor" },
      ],
    });
    const approved = decideIntercompanyOrder(order, {
      action: "ACCEPT",
      actor_company_id: s,
      idempotency_key: "accept-constructor-line-key",
    }).order;
    const shipped = applySupplierFulfilment(approved, {
      shipment_id: "CONSTRUCTOR",
      idempotency_key: "constructor-shipment-key",
      actor_company_id: s,
      quantities_by_source_line: { constructor: "2.5" },
    });
    expect(shipped.state).toBe("FULFILLED");
    expect(shipped.fulfilled_quantities_by_line.constructor).toBe("2.5");
  });

  it("uses supplier as order owner while EC remains customer and issuer", () => {
    const x = decideIntercompanyOrder(
      createIntercompanyPurchaseOrder(input()),
      {
        action: "ACCEPT",
        actor_company_id: s,
        idempotency_key: "accept-request-44444444",
      },
    );
    expect(x.intent?.customer_order_owner_company_id).toBe(s);
    expect(x.intent?.customer_company_id).toBe(b);
    expect(x.intent?.supplier_purchase_lines[0]).not.toHaveProperty(
      "ec_sale_unit_price",
    );
  });
  it("allows equal prices and distinct currencies", () =>
    expect(() => createIntercompanyPurchaseOrder(input())).not.toThrow());
  it("requires an exchange environment and keeps the customer delivery address in the supplier intent", () => {
    expect(() =>
      createIntercompanyPurchaseOrder(
        Object.fromEntries(
          Object.entries(input()).filter(([key]) => key !== "environment"),
        ),
      ),
    ).toThrow();
    const result = decideIntercompanyOrder(
      createIntercompanyPurchaseOrder(input()),
      {
        action: "ACCEPT",
        actor_company_id: s,
        idempotency_key: "accept-request-44444444",
      },
    );
    expect(result.intent?.final_delivery_address.city).toBe("Lyon");
  });
  it("rejects a third party and arbitrary technical dossier", () => {
    expect(() =>
      decideIntercompanyOrder(createIntercompanyPurchaseOrder(input()), {
        action: "ACCEPT",
        actor_company_id: t,
        idempotency_key: "third-party-request-44",
      }),
    ).toThrow();
    expect(() =>
      createIntercompanyPurchaseOrder({
        ...input(),
        lines: [
          {
            ...input().lines[0],
            technical_supplier_reference: {
              piece_technique_id: p,
              piece_technique_version_id: v,
              gamme: {},
            },
          },
        ],
      }),
    ).toThrow();
  });
  it("requires a supplier confirmation or refusal of cancellation", () => {
    const pending = decideIntercompanyOrder(accepted(), {
      action: "REQUEST_CANCEL",
      actor_company_id: b,
      idempotency_key: "cancel-request-44444444",
      reason: "changed",
    }).order;
    expect(
      decideIntercompanyOrder(pending, {
        action: "REJECT_CANCEL",
        actor_company_id: s,
        idempotency_key: "reject-cancel-44444444",
        reason: "shipped",
      }).order.state,
    ).toBe("CANCELLATION_REJECTED");
  });
  it("closes a pending request before supplier acceptance without creating real fulfilment", () => {
    const pending = createIntercompanyPurchaseOrder(input());
    const cancelled = decideIntercompanyOrder(pending, {
      action: "REQUEST_CANCEL",
      actor_company_id: b,
      idempotency_key: "cancel-pending-request-44",
    }).order;
    expect(cancelled.state).toBe("CANCELLED");
    expect(cancelled.supplier_shipments).toEqual([]);
  });
  it("marks decision double clicks and conflicting reuse", () => {
    const o = createIntercompanyPurchaseOrder(input()),
      d = {
        action: "ACCEPT" as const,
        actor_company_id: s,
        idempotency_key: "accept-request-44444444",
      },
      receipt = receiptForIntercompanyDecision(
        o,
        d,
        decideIntercompanyOrder(o, d),
      );
    expect(resolveIntercompanyDecisionIdempotency(o, d, receipt)).toMatchObject(
      { replay: true },
    );
    expect(
      resolveIntercompanyDecisionIdempotency(
        o,
        { ...d, action: "REJECT", reason: "different" },
        receipt,
      ),
    ).toMatchObject({ conflict: true });
  });
  it("accumulates 0.1 and 0.2 exactly and replays shipment safely", () => {
    let o = accepted();
    o = applySupplierFulfilment(o, {
      shipment_id: "S1",
      idempotency_key: "shipment-key-000001",
      actor_company_id: s,
      quantities_by_source_line: { "EC-SO-1/1": "0.1" },
    });
    o = applySupplierFulfilment(o, {
      shipment_id: "S2",
      idempotency_key: "shipment-key-000002",
      actor_company_id: s,
      quantities_by_source_line: { "EC-SO-1/1": "0.2" },
    });
    expect(o.fulfilled_quantities_by_line["EC-SO-1/1"]).toBe("0.3");
    expect(
      applySupplierFulfilment(o, {
        shipment_id: "S2",
        idempotency_key: "shipment-key-000002",
        actor_company_id: s,
        quantities_by_source_line: { "EC-SO-1/1": "0.2" },
      }),
    ).toBe(o);
  });
  it("replays a completed shipment and rejects a changed terminal payload", () => {
    let o = accepted();
    o = applySupplierFulfilment(o, {
      shipment_id: "ALL",
      idempotency_key: "shipment-key-complete",
      actor_company_id: s,
      quantities_by_source_line: { "EC-SO-1/1": "2.5" },
    });
    expect(o.state).toBe("FULFILLED");
    expect(
      applySupplierFulfilment(o, {
        shipment_id: "ALL",
        idempotency_key: "shipment-key-complete",
        actor_company_id: s,
        quantities_by_source_line: { "EC-SO-1/1": "2.5" },
      }),
    ).toBe(o);
    expect(() =>
      applySupplierFulfilment(o, {
        shipment_id: "ALL",
        idempotency_key: "shipment-key-complete",
        actor_company_id: s,
        quantities_by_source_line: { "EC-SO-1/1": "2.4" },
      }),
    ).toThrow("INTERCOMPANY_FULFILMENT_IDEMPOTENCY_CONFLICT");
  });
  it("rejects over-fulfilment, huge values and shipment-key conflict", () => {
    const o = accepted();
    expect(() =>
      applySupplierFulfilment(o, {
        shipment_id: "S1",
        idempotency_key: "shipment-key-000001",
        actor_company_id: s,
        quantities_by_source_line: { "EC-SO-1/1": "2.500001" },
      }),
    ).toThrow();
    expect(() =>
      createIntercompanyPurchaseOrder({
        ...input(),
        lines: [{ ...input().lines[0], quantity: "1000000000000" }],
      }),
    ).toThrow();
    const q = applySupplierFulfilment(o, {
      shipment_id: "S1",
      idempotency_key: "shipment-key-000001",
      actor_company_id: s,
      quantities_by_source_line: { "EC-SO-1/1": "1" },
    });
    expect(() =>
      applySupplierFulfilment(q, {
        shipment_id: "S1",
        idempotency_key: "shipment-key-000001",
        actor_company_id: s,
        quantities_by_source_line: { "EC-SO-1/1": "1.1" },
      }),
    ).toThrow();
  });
  it("hashes complete payload canonically and rejects non JSON", () => {
    const a = createIntercompanyPurchaseOrder(input()),
      q = createIntercompanyPurchaseOrder({
        ...input(),
        final_delivery_address: {
          ...input().final_delivery_address,
          city: "Paris",
        },
      });
    expect(a.immutable_payload_sha256).not.toBe(q.immutable_payload_sha256);
    expect(sha256Canonical({ b: 2, a: { z: true } })).toBe(
      sha256Canonical({ a: { z: true }, b: 2 }),
    );
    expect(() => sha256Canonical(new Date())).toThrow();
  });
});
