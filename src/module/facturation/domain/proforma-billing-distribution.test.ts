import { describe, expect, it } from "vitest";
import { proformaBillingDistribution } from "./proforma-billing-distribution";

const source = { sourceQuantity: "100", unitPriceExTax: "10.00", discountPercent: "0", globalDiscountPercent: "0", taxRatePercent: "20" };

describe("one order billed to several companies", () => {
  it("keeps quantities and fiscal amounts separate for each billed company", () => {
    expect(proformaBillingDistribution({ ...source, parts: [
      { billedClientId: "COMPANY-A", quantity: "30" }, { billedClientId: "COMPANY-B", quantity: "70" },
    ] })).toEqual([
      { billedClientId: "COMPANY-A", quantity: "30.000", globalDiscountPercent: "0.0000", globalDiscountAmount: "0.00", totalExTax: "300.00", taxAmount: "60.00", totalInclTax: "360.00" },
      { billedClientId: "COMPANY-B", quantity: "70.000", globalDiscountPercent: "0.0000", globalDiscountAmount: "0.00", totalExTax: "700.00", taxAmount: "140.00", totalInclTax: "840.00" },
    ]);
  });
  it("preserves fractional units without floating point drift", () => {
    expect(proformaBillingDistribution({ ...source, sourceQuantity: "0.300", parts: [
      { billedClientId: "A", quantity: "0.100" }, { billedClientId: "B", quantity: "0.200" },
    ] }).map(part => part.totalInclTax)).toEqual(["1.20", "2.40"]);
  });
  it.each(["29", "31"])("rejects an incomplete or excessive total (%s + 70)", quantity => {
    expect(() => proformaBillingDistribution({ ...source, parts: [
      { billedClientId: "A", quantity }, { billedClientId: "B", quantity: "70" },
    ] })).toThrow("exactement la quantité");
  });
  it("rejects duplicate company entries", () => {
    expect(() => proformaBillingDistribution({ ...source, parts: [
      { billedClientId: "A", quantity: "30" }, { billedClientId: "A", quantity: "70" },
    ] })).toThrow("une seule fois");
  });
  it.each(["0", "-1"])("rejects a nonpositive company quantity %s", quantity => {
    expect(() => proformaBillingDistribution({ ...source, parts: [{ billedClientId: "A", quantity }] })).toThrow("positive");
  });
  it("requires a selected company identity", () => {
    expect(() => proformaBillingDistribution({ ...source, parts: [{ billedClientId: " ", quantity: "100" }] })).toThrow("Sélectionnez");
  });
  it("rounds each company's fiscal document separately", () => {
    expect(proformaBillingDistribution({ ...source, sourceQuantity: "3", unitPriceExTax: "0.0050", parts: [
      { billedClientId: "A", quantity: "1" }, { billedClientId: "B", quantity: "2" },
    ] }).map(part => part.totalExTax)).toEqual(["0.01", "0.01"]);
  });
  it("retains both the line discount and the order's global discount", () => {
    expect(proformaBillingDistribution({ ...source, discountPercent: "5", globalDiscountPercent: "10",
      parts: [{ billedClientId: "A", quantity: "100" }] })[0])
      .toMatchObject({ globalDiscountAmount: "95.00", totalExTax: "855.00", taxAmount: "171.00", totalInclTax: "1026.00" });
  });
});
