import { describe, expect, it } from "vitest";
import { projectDeliveryServiceKpis } from "./delivery-service-kpis";

describe("delivery service KPIs", () => {
  it("keeps BL evidence trace while calculating shipment-to-receipt rate", () => {
    const result = projectDeliveryServiceKpis([
      {
        bon_livraison_id: "bl-2",
        client_id: "c-1",
        client_name: "Vision",
        receipt_at: null,
      },
      {
        bon_livraison_id: "bl-1",
        client_id: "c-1",
        client_name: "Vision",
        receipt_at: "2026-10-02T12:00:00Z",
      },
      {
        bon_livraison_id: "bl-3",
        client_id: "c-2",
        client_name: "Clayens",
        receipt_at: null,
      },
    ]);
    expect(result).toMatchObject({
      dispatched_count: 3,
      receipt_confirmed_count: 1,
      receipt_pending_count: 2,
      receipt_rate: 1 / 3,
    });
    expect(
      result.per_client.find((value) => value.client_id === "c-1"),
    ).toMatchObject({ receipt_rate: 0.5, pending_bon_livraison_ids: ["bl-2"] });
  });

  it("reports an unavailable rate when no dispatch was in scope", () => {
    expect(projectDeliveryServiceKpis([])).toMatchObject({
      dispatched_count: 0,
      receipt_rate: null,
      per_client: [],
    });
  });
});
