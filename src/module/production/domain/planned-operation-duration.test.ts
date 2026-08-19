import { describe, expect, it } from "vitest";
import { computePlannedOperationDurationMinutes } from "./planned-operation-duration";

describe("canonical planned operation duration", () => {
  it.each([
    { launchedQuantity: 0, expected: 30 },
    { launchedQuantity: 1, expected: 42 },
    { launchedQuantity: 2, expected: 54 },
  ])("computes setup plus per-unit load for quantity $launchedQuantity", ({ launchedQuantity, expected }) => {
    expect(computePlannedOperationDurationMinutes({
      setupHours: 0.5,
      unitHours: 0.2,
      baseQuantity: 1,
      launchedQuantity,
      coefficient: 1,
    })).toBe(expected);
  });

  it("applies base quantity and coefficient only to execution time", () => {
    expect(computePlannedOperationDurationMinutes({
      setupHours: 0.5,
      unitHours: 0.1,
      baseQuantity: 2,
      launchedQuantity: 3,
      coefficient: 1.5,
    })).toBe(84);
  });

  it("rejects missing/invalid numeric evidence instead of fabricating a duration", () => {
    expect(() => computePlannedOperationDurationMinutes({
      setupHours: Number.NaN,
      unitHours: 0.2,
      baseQuantity: 1,
      launchedQuantity: 2,
      coefficient: 1,
    })).toThrow(/setupHours/);
  });
});
