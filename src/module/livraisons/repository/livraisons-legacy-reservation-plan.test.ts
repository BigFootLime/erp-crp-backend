import { describe, expect, it } from "vitest";

import { buildLegacyShipmentReservationPlan } from "./livraisons.repository";

describe("legacy shipment reservation consumption plan (#616)", () => {
  it("keeps ACTIVE reservation-backed quantity out of the direct Quality debit", () => {
    const plan = buildLegacyShipmentReservationPlan([
      { allocation_id: "a", quantite: 4, reservation_id: "r-1", reservation_status: "ACTIVE", reservation_qty: 4 },
      { allocation_id: "b", quantite: 3, reservation_id: null, reservation_status: null, reservation_qty: null },
    ]);
    expect(plan).toEqual({ committed_qty: 4, direct_qty: 3, reservation_ids: ["r-1"] });
  });

  it("aggregates multiple allocations for one reservation only when they consume it exactly", () => {
    expect(buildLegacyShipmentReservationPlan([
      { allocation_id: "a", quantite: 2, reservation_id: "r-1", reservation_status: "ACTIVE", reservation_qty: 5 },
      { allocation_id: "b", quantite: 3, reservation_id: "r-1", reservation_status: "ACTIVE", reservation_qty: 5 },
    ])).toEqual({ committed_qty: 5, direct_qty: 0, reservation_ids: ["r-1"] });
  });

  it("fails closed for a partial ACTIVE reservation instead of consuming another delivery's claim", () => {
    expect(() => buildLegacyShipmentReservationPlan([
      { allocation_id: "a", quantite: 2, reservation_id: "r-1", reservation_status: "ACTIVE", reservation_qty: 5 },
    ])).toThrow(expect.objectContaining({ code: "RESERVATION_ALLOCATION_MISMATCH" }));
  });
});
