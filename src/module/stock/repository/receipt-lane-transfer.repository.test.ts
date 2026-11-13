import { describe, expect, it, vi } from "vitest";

const movement = vi.hoisted(() => ({
  create: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./stock-movement-core.repository", () => ({
  repoCreateMovement: movement.create,
  repoPostMovement: movement.post,
}));

vi.mock("./stock-lane-routing.repository", () => ({
  getActiveStockLaneDestinationsTx: vi.fn(),
}));

import { getActiveStockLaneDestinationsTx } from "./stock-lane-routing.repository";
import { routeReceiptLaneDistributionTx } from "./receipt-lane-transfer.repository";

const ids = {
  receipt: "11111111-1111-1111-1111-111111111111",
  article: "22222222-2222-2222-2222-222222222222",
  lot: "33333333-3333-3333-3333-333333333333",
  sourceLevel: "44444444-4444-4444-4444-444444444444",
  sourceBatch: "55555555-5555-5555-5555-555555555555",
  sourceLocation: "66666666-6666-6666-6666-666666666666",
  destinationLocation: "77777777-7777-7777-7777-777777777777",
  destinationMagasin: "88888888-8888-8888-8888-888888888888",
};

describe("routeReceiptLaneDistributionTx", () => {
  it("passes the caller-owned transaction to both core movement operations", async () => {
    vi.mocked(getActiveStockLaneDestinationsTx).mockResolvedValue([
      {
        lane: "DELIVERY",
        magasin_id: ids.destinationMagasin,
        emplacement_id: 12,
        location_id: ids.destinationLocation,
        magasin_code: "PF",
        emplacement_code: "EXP",
        valid: true,
      },
    ]);
    movement.create.mockResolvedValue({ movement: { id: "99999999-9999-9999-9999-999999999999" } });
    movement.post.mockResolvedValue({ movement: { id: "99999999-9999-9999-9999-999999999999", status: "POSTED" } });

    const tx = {
      query: vi.fn(async (sql: unknown) => {
        const text = String(sql);
        if (text.includes("JOIN public.units")) {
          return { rows: [{ magasin_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", emplacement_id: 10, unit: "U" }] };
        }
        if (text.includes("FROM public.stock_levels sl JOIN public.stock_batches")) {
          return { rows: [{ stock_level_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", stock_batch_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" }] };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const audit = { user_id: 7, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };

    await routeReceiptLaneDistributionTx(tx as never, {
      receipt_id: ids.receipt,
      article_id: ids.article,
      lot_id: ids.lot,
      stock_level_id: ids.sourceLevel,
      stock_batch_id: ids.sourceBatch,
      location_id: ids.sourceLocation,
      distribution: { received_quantity: "2", physical_routing_applied: false, destinations: [{ lane: "DELIVERY", quantity: "2", reservations: [] }] },
    }, audit);

    expect(movement.create).toHaveBeenCalledWith(expect.any(Object), audit, expect.objectContaining({ client: tx, trusted_source_flow: true }));
    expect(movement.post).toHaveBeenCalledWith("99999999-9999-9999-9999-999999999999", {}, audit, expect.any(String), tx);
    expect(tx.query.mock.calls.map(([sql]) => String(sql))).not.toContain("BEGIN");
    expect(tx.query.mock.calls.map(([sql]) => String(sql))).not.toContain("COMMIT");
    expect(tx.query.mock.calls.map(([sql]) => String(sql))).not.toContain("ROLLBACK");
  });
});
