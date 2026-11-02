import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../../config/database", () => ({
  default: { connect: mocked.connect },
}));
vi.mock("./client-portal.repository", () => ({
  repoInsertPortalAudit: vi.fn(),
}));

import { repoCreatePortalDeliveryReceipt } from "./client-portal-delivery-receipts.repository";

describe("portal delivery receipt", () => {
  beforeEach(() => mocked.connect.mockReset());
  it("does not disclose or accept a same-client delivery at another site", async () => {
    const tx = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    mocked.connect.mockResolvedValueOnce(tx);
    await expect(
      repoCreatePortalDeliveryReceipt({
        identity: {
          accountId: "11111111-1111-4111-8111-111111111111",
          clientId: "042",
          sessionEpoch: 1,
        },
        deliveryId: "22222222-2222-4222-8222-222222222222",
        idempotencyKey: "33333333-3333-4333-8333-333333333333",
        deliveredAt: "2026-10-31T10:00:00.000Z",
        receivedByName: null,
        note: null,
        lines: [
          {
            delivery_line_id: "44444444-4444-4444-8444-444444444444",
            quantity_received: 1,
          },
        ],
        meta: { requestId: null, ipHash: null, userAgentFamily: null },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "CLIENT_PORTAL_DELIVERY_NOT_FOUND",
    });
    const deliverySql = String(tx.query.mock.calls[2]?.[0]);
    expect(deliverySql).toContain("client_portal_delivery_site_bindings");
    expect(tx.query.mock.calls.at(-1)?.[0]).toContain("ROLLBACK");
  });
});
