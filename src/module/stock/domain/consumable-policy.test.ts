import { describe, expect, it } from "vitest";
import { assertConsumablePolicy, assertPackDepletion, consumablePurchaseQuantity, sharedPackCoverage } from "./consumable-policy";

describe("consumable purchase and depletion policy", () => {
  it("buys whole packs without assigning the surplus to the OF", () => {
    expect(consumablePurchaseQuantity({ shortage: 120, articlePack: 100 })).toEqual({ ordered: 200, assigned: 120, stockQuantity: 200, surplus: 80 });
    expect(consumablePurchaseQuantity({ shortage: 120 - 30, articlePack: 100 })).toEqual({ ordered: 100, assigned: 90, stockQuantity: 100, surplus: 10 });
  });
  it("honours supplier minimum and purchase/stock conversion", () => {
    expect(consumablePurchaseQuantity({ shortage: 90, articlePack: 100, coefficient: 100, supplierPack: 1, supplierMinimum: 2 })).toEqual({ ordered: 2, assigned: 90, stockQuantity: 200, surplus: 110 });
    expect(consumablePurchaseQuantity({ shortage: 0, articlePack: 100 }).ordered).toBe(0);
  });
  it("keeps a common pack shared rather than reserving it for each OF", () => {
    expect(sharedPackCoverage(1, 0)).toEqual({ shared: true, available: true, state: "SHARED_AVAILABLE" });
    expect(sharedPackCoverage(0, 100).state).toBe("EXPECTED");
    expect(sharedPackCoverage(0, 0).state).toBe("MISSING");
  });
  it("refuses stale, empty or reserved pack depletion", () => {
    expect(assertPackDepletion({ total: 100, reserved: 0, expected: 100 })).toBe(100);
    for (const input of [{ total: 80, reserved: 0, expected: 100 }, { total: 0, reserved: 0, expected: 0 }, { total: 100, reserved: 1, expected: 100 }]) expect(() => assertPackDepletion(input)).toThrow();
  });
  it("does not weaken the quality or stock policy of other categories", () => {
    expect(() => assertConsumablePolicy({ article_categories: ["matiere_premiere"], stock_managed: true, lot_tracking: true, receipt_quality_required: false })).toThrow();
    expect(() => assertConsumablePolicy({ article_categories: ["consommable"], stock_managed: true, lot_tracking: false, consumption_mode: "GLOBAL_PACK" })).toThrow();
    expect(() => assertConsumablePolicy({ article_categories: ["consommable"], stock_managed: false, lot_tracking: false, receipt_quality_required: false })).not.toThrow();
  });
});
