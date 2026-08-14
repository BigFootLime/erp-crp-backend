import { describe, expect, it } from "vitest";

import { assertFiniteQuantities } from "./production-execution";

describe("production operation finish quantity validation", () => {
  it("allows an empty delta when the operation already has its declaration", () => {
    expect(() =>
      assertFiniteQuantities(
        { qty_good: 0, qty_scrap: 0, qty_rework: 0, qty_pending_control: 0 },
        { allowEmpty: true },
      )
    ).not.toThrow();
  });

  it("still rejects an empty standalone quantity declaration", () => {
    expect(() =>
      assertFiniteQuantities({ qty_good: 0, qty_scrap: 0, qty_rework: 0, qty_pending_control: 0 })
    ).toThrowError(/vide/i);
  });
});
