import { describe, expect, it } from "vitest";
import { money, quantity, unitPrice } from "../shared/pdf/format-fr";

describe("Supplier PDF decimal precision (#1176)", () => {
  it.each([
    ["0.0250", "0,025 €"],
    ["0.0001", "0,0001 €"],
    ["0.000001", "0,000001 €"],
    ["0", "0,00 €"],
    ["10.0000", "10,00 €"],
    ["00012,5000", "12,50 €"],
    ["12345678901234567890.0250", "12 345 678 901 234 567 890,025 €"],
  ])("preserves the agreed unit price %s", (input, expected) => {
    expect(unitPrice(input, "EUR")).toBe(expected);
  });

  it.each([
    ["3000.000", "3 000"], ["12.500", "12,5"], ["0.001", "0,001"],
    ["0004.000", "4"], ["0", "0"], ["12345678901234567890.125", "12 345 678 901 234 567 890,125"],
  ])("shows a readable exact quantity %s", (input, expected) => {
    expect(quantity(input)).toBe(expected);
  });

  it("keeps other currencies and monetary totals unchanged", () => {
    expect(unitPrice("0.025", "USD")).toBe("0,025 USD");
    expect(money("75.000", "EUR")).toBe("75,00 €");
    expect(money("90.000", "EUR")).toBe("90,00 €");
    expect(money("0.025", "EUR")).toBe("0,03 €");
  });

  it.each(["", "1 000.00", "NaN", "Infinity", "1e-3", "1.2.3"])('rejects an ambiguous value "%s"', input => {
    expect(() => unitPrice(input, "EUR")).toThrow("PDF_UNIT_PRICE_INVALID");
    expect(() => quantity(input)).toThrow("PDF_QUANTITY_INVALID");
  });
});
