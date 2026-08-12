import { describe, expect, it } from "vitest";

import {
  leadTimeVariabilityDays,
  normalizeReceiptQuantity,
  rejectionRatePct,
  supplierOtdPct,
  weightedPriceVariancePct,
} from "./procurement-reliability";

describe("SOL-18 procurement KPI formulas", () => {
  it("calculates OTD on the due-commitment cohort without fabricating an empty rate", () => {
    expect(supplierOtdPct(8, 10)).toBe(80);
    expect(supplierOtdPct(0, 0)).toBeNull();
    expect(supplierOtdPct(11, 10)).toBeNull();
  });

  it("calculates population lead-time variability and requires two observations", () => {
    expect(leadTimeVariabilityDays([8, 10, 12])).toBe(1.63);
    expect(leadTimeVariabilityDays([8])).toBeNull();
  });

  it("calculates weighted price variance and rejection rate from explicit denominators", () => {
    expect(weightedPriceVariancePct({ orderedAmount: 1_000, invoicedAmount: 1_050 })).toBe(5);
    expect(weightedPriceVariancePct({ orderedAmount: 0, invoicedAmount: 0 })).toBeNull();
    expect(rejectionRatePct(2, 40)).toBe(5);
    expect(rejectionRatePct(0, 0)).toBeNull();
  });

  it("normalizes multiple units only with an explicit conversion factor", () => {
    expect(normalizeReceiptQuantity({
      receiptQty: 12,
      receiptUnit: "m",
      purchaseUnit: "m",
      stockUnit: "mm",
      stockUnitsPerPurchaseUnit: 1_000,
    })).toEqual({ status: "EXACT", purchaseQty: 12 });
    expect(normalizeReceiptQuantity({
      receiptQty: 12_000,
      receiptUnit: "mm",
      purchaseUnit: "m",
      stockUnit: "mm",
      stockUnitsPerPurchaseUnit: 1_000,
    })).toEqual({ status: "CONVERTED", purchaseQty: 12 });
    expect(normalizeReceiptQuantity({
      receiptQty: 12,
      receiptUnit: "kg",
      purchaseUnit: "m",
      stockUnit: "mm",
      stockUnitsPerPurchaseUnit: 1_000,
    })).toEqual({ status: "UNCONVERTIBLE", purchaseQty: null });
  });
});
