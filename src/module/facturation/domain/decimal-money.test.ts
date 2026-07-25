import { describe, expect, it } from "vitest";

import {
  computeExactDocumentTotals,
  computeExactLineTotals,
  divideHalfUp,
  formatDecimal,
  parseDecimal,
} from "./decimal-money";

describe("issue #227 — décimales exactes", () => {
  it.each([
    ["0", 2, 0n],
    ["1", 2, 100n],
    ["1.2", 2, 120n],
    ["1.23", 2, 123n],
    ["999999.99", 2, 99_999_999n],
    ["0.001", 3, 1n],
    ["12.3456", 4, 123_456n],
    ["-1.25", 2, -125n],
  ] as const)("parse %s scale %s", (value, scale, expected) => {
    expect(parseDecimal(value, scale, "test")).toBe(expected);
    expect(formatDecimal(expected, scale)).toBe(
      `${expected < 0n ? "-" : ""}${(() => {
        const absolute = expected < 0n ? -expected : expected;
        const divisor = 10n ** BigInt(scale);
        return `${absolute / divisor}.${String(absolute % divisor).padStart(scale, "0")}`;
      })()}`
    );
  });

  it.each([
    [1n, 2n, 1n],
    [2n, 3n, 1n],
    [1n, 3n, 0n],
    [5n, 10n, 1n],
    [-5n, 10n, -1n],
  ] as const)("arrondi half-up %s/%s", (numerator, denominator, expected) => {
    expect(divideHalfUp(numerator, denominator)).toBe(expected);
  });

  it("calcule une ligne sans flottants", () => {
    expect(
      computeExactLineTotals({
        quantity: "3.000",
        unitPriceExTax: "19.9900",
        discountPercent: "10.0000",
        taxRatePercent: "20.0000",
      })
    ).toEqual({
      totalExTax: "53.97",
      taxAmount: "10.79",
      totalInclTax: "64.76",
    });
  });

  it("applique la remise globale aux bases et taxes agrégées", () => {
    expect(
      computeExactDocumentTotals(
        [
          {
            quantity: "1.000",
            unitPriceExTax: "100.0000",
            discountPercent: "0",
            taxRatePercent: "20",
          },
          {
            quantity: "2.000",
            unitPriceExTax: "50.0000",
            discountPercent: "0",
            taxRatePercent: "10",
          },
        ],
        "5"
      )
    ).toEqual({
      subtotalExTax: "200.00",
      discountPercent: "5.0000",
      discountAmount: "10.00",
      totalExTax: "190.00",
      totalTax: "28.50",
      totalInclTax: "218.50",
    });
  });

  it.each(["1.234", "NaN", "1e3", "", " 1,20 "])("refuse %s à l'échelle monétaire", (value) => {
    expect(() => parseDecimal(value, 2, "test")).toThrow();
  });
});
