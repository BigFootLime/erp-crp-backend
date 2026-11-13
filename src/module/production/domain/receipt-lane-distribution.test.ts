import { describe, expect, it } from "vitest";
import { distributeReceiptToStockLanes } from "./receipt-lane-distribution";

describe("receipt distribution — combined business acceptance fixtures, not yet executed", () => {
  it("routes an actual order remainder of 100 and the surplus 20 from a receipt of 120", () => {
    const distribution = distributeReceiptToStockLanes("120", [{ reservation_id: "delivery", lane: "DELIVERY", quantity: "100" }]);
    expect(distribution.destinations.map(({ lane, quantity }) => ({ lane, quantity }))).toEqual([
      { lane: "DELIVERY", quantity: "100" }, { lane: "FREE", quantity: "20" },
    ]);
  });
  it("does not count a reservation twice or allow received stock to cover excessive demand", () => {
    expect(() => distributeReceiptToStockLanes("120", [{ reservation_id: "same", lane: "DELIVERY", quantity: "100" },
      { reservation_id: "same", lane: "ASSEMBLY", quantity: "20" }])).toThrow(/seule affectation/);
    expect(() => distributeReceiptToStockLanes("100", [{ reservation_id: "order", lane: "DELIVERY", quantity: "101" }])).toThrow(/dépassent/);
  });
  it("keeps anticipated contract production without a firm reservation entirely free", () => {
    expect(distributeReceiptToStockLanes("80", []).destinations).toEqual([{ lane: "FREE", quantity: "80", reservations: [] }]);
  });
  it("preserves fractional quantities exactly when delivery and assembly share a receipt", () => {
    const result = distributeReceiptToStockLanes("0.3", [{ reservation_id: "d", lane: "DELIVERY", quantity: "0.1" },
      { reservation_id: "a", lane: "ASSEMBLY", quantity: "0.1" }]);
    expect(result.destinations.map(destination => destination.quantity)).toEqual(["0.1", "0.1", "0.1"]);
  });
});
