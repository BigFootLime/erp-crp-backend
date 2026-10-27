import { describe, expect, it, vi } from "vitest";

import {
  applyIntercompanyFulfilmentMessageTx,
} from "./intercompany-fulfilment.repository";
import type { IntercompanyMessage } from "./intercompany-message";

const ids = {
  message: "11111111-1111-4111-8111-111111111111",
  source: "22222222-2222-4222-8222-222222222222",
  destination: "33333333-3333-4333-8333-333333333333",
  receipt: "44444444-4444-4444-8444-444444444444",
  relation: "55555555-5555-4555-8555-555555555555",
  purchaseOrder: "66666666-6666-4666-8666-666666666666",
  purchaseLine: "77777777-7777-4777-8777-777777777777",
};

function shipment(overrides: Partial<IntercompanyMessage> = {}): IntercompanyMessage {
  return {
    id: ids.message,
    source_company_id: ids.source,
    destination_company_id: ids.destination,
    environment: "cerp_prod",
    kind: "SHIPMENT_DISPATCHED",
    aggregate_id: "request-42",
    revision: 2,
    occurred_at: "2026-10-27T08:00:00.000Z",
    payload_sha256: "a".repeat(64),
    payload: {
      schema_version: 1,
      receipt_id: ids.receipt,
      relation_id: ids.relation,
      buyer_sales_order_id: "42",
      buyer_purchase_order_id: ids.purchaseOrder,
      seller_delivery_id: "seller-delivery-42",
      seller_delivery_number: "BL-42",
      dispatched_at: "2026-10-27T08:00:00.000Z",
      document: { id: "seller-bl-pdf-42", sha256: "b".repeat(64) },
      lines: [{
        buyer_sales_order_line_id: "420",
        buyer_purchase_order_line_id: ids.purchaseLine,
        seller_delivery_line_id: "seller-line-1",
        quantity: 2,
        unit: "EA",
      }],
    },
    ...overrides,
  };
}

function txForAppliedReceipt() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.intercompany_purchase_order_links")) {
        return { rows: [{ id: "42", fulfilment_mode: "SUPPLIER_DROPSHIP" }] };
      }
      if (sql.includes("FROM public.intercompany_purchase_order_line_links")) {
        return { rows: [{ id: "420", buyer_purchase_order_line_id: ids.purchaseLine, quantity: "3" }] };
      }
      if (sql.includes("INSERT INTO public.cerp_intercompany_external_fulfilment_receipts")) {
        return { rows: [{ message_id: ids.message }] };
      }
      if (sql.includes("INSERT INTO public.cerp_intercompany_external_fulfilment_receipt_lines")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  };
}

describe("intercompany fulfilment receipt", () => {
  it("accepts a partial signed shipment without writing stock", async () => {
    const tx = txForAppliedReceipt();

    await expect(applyIntercompanyFulfilmentMessageTx(tx as never, shipment())).resolves.toEqual({
      applied: true,
      receipt_id: ids.receipt,
    });

    expect(tx.query).toHaveBeenCalledWith(
      expect.stringContaining("cerp_intercompany_external_fulfilment_receipt_lines"),
      expect.arrayContaining([ids.message, 1, "420", ids.purchaseLine, "seller-line-1", 2, "EA"]),
    );
    expect(tx.query.mock.calls.map(([sql]) => String(sql)).join("\n")).not.toMatch(/stock_levels|stock_movements|bon_livraison_ligne_allocations/i);
  });

  it("replays a delivery receipt without adding proof lines twice", async () => {
    const tx = txForAppliedReceipt();
    tx.query.mockImplementation((async (sql: string) => {
      if (sql.includes("FROM public.intercompany_purchase_order_links")) return { rows: [{ id: "42", fulfilment_mode: "SUPPLIER_DROPSHIP" }] };
      if (sql.includes("FROM public.intercompany_purchase_order_line_links")) return { rows: [{ id: "420", buyer_purchase_order_line_id: ids.purchaseLine, quantity: "3" }] };
      if (sql.includes("INSERT INTO public.cerp_intercompany_external_fulfilment_receipts")) return { rows: [] };
      if (sql.includes("WHERE message_id = $1::uuid")) return { rows: [{ receipt_id: ids.receipt }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }) as never);

    await expect(applyIntercompanyFulfilmentMessageTx(tx as never, shipment())).resolves.toEqual({
      applied: false,
      receipt_id: ids.receipt,
    });
    expect(tx.query.mock.calls.map(([sql]) => String(sql)).join("\n")).not.toContain("INSERT INTO public.cerp_intercompany_external_fulfilment_receipt_lines");
  });

  it("rejects cancellation and duplicate proof lines before persisting a receipt", async () => {
    const tx = txForAppliedReceipt();
    await expect(applyIntercompanyFulfilmentMessageTx(tx as never, shipment({ kind: "CANCEL_REQUESTED" }))).rejects.toMatchObject({
      code: "INTERCOMPANY_FULFILMENT_KIND_UNSUPPORTED",
    });
    const duplicate = shipment();
    await expect(applyIntercompanyFulfilmentMessageTx(tx as never, shipment({
      payload: {
        ...duplicate.payload,
        lines: [
          (duplicate.payload.lines as unknown[])[0],
          (duplicate.payload.lines as unknown[])[0],
        ],
      },
    } as never))).rejects.toMatchObject({ code: "INTERCOMPANY_FULFILMENT_LINES_DUPLICATE" });
    expect(tx.query).not.toHaveBeenCalled();
  });
});
