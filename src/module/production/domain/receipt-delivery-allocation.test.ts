import { describe, expect, it } from "vitest";
import { allocateReceiptToDeliveryDemands, type ReceiptDeliveryDemand } from "./receipt-delivery-allocation";

const demand = (allocation_id: number, ordered: string, due_date: string, extra: Partial<ReceiptDeliveryDemand> = {}): ReceiptDeliveryDemand =>
  ({ allocation_id, livraison_affaire_id: allocation_id + 100, ordered, due_date,
    delivered: "0", reserved_remaining: "0", unreserved_prepared: "0", ...extra });

describe("production receipt delivery demand coverage", () => {
  it("covers 20 urgent and then 80 at the original AR even when inserted in reverse order", () => {
    expect(allocateReceiptToDeliveryDemands("120", "100", [demand(1, "80", "2026-11-30"), demand(2, "20", "2026-11-10")], null))
      .toEqual([{ allocation_id: 2, livraison_affaire_id: 102, quantity: "20" }, { allocation_id: 1, livraison_affaire_id: 101, quantity: "80" }]);
  });
  it("counts a prepared reservation once and received production only against the actual remainder", () => {
    expect(allocateReceiptToDeliveryDemands("100", "100", [demand(1, "100", "2026-11-30", {
      delivered: "30", reserved_remaining: "20", unreserved_prepared: "0" })], null)).toEqual([
      { allocation_id: 1, livraison_affaire_id: 101, quantity: "50" },
    ]);
  });
  it("keeps an explicit recovery affair within its own demand", () => {
    expect(allocateReceiptToDeliveryDemands("100", "100", [demand(1, "80", "2026-11-30"), demand(2, "20", "2026-11-10")], 101))
      .toEqual([{ allocation_id: 1, livraison_affaire_id: 101, quantity: "80" }]);
  });
  it("does not duplicate a legacy prepared quantity which has no reservation", () => {
    expect(allocateReceiptToDeliveryDemands("10", "10", [demand(1, "10", "2026-11-30", { unreserved_prepared: "6" })], null))
      .toEqual([{ allocation_id: 1, livraison_affaire_id: 101, quantity: "4" }]);
  });
  it("rejects affairs exceeding the order and preserves fractional stock exactly", () => {
    expect(() => allocateReceiptToDeliveryDemands("100", "100", [demand(1, "80", "2026-11-30"), demand(2, "30", "2026-11-10")], null))
      .toThrow(/dépassent/);
    expect(allocateReceiptToDeliveryDemands("0.3", "0.3", [demand(1, "0.3", "2026-11-30", { delivered: "0.1", reserved_remaining: "0.1" })], null))
      .toEqual([{ allocation_id: 1, livraison_affaire_id: 101, quantity: "0.1" }]);
  });
});
