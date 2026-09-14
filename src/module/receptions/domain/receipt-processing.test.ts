import { describe, expect, it } from "vitest";
import {
  assertPackingQuantity,
  assertStockingQuantity,
  processingPolicy,
  receiptProcessingState,
} from "./receipt-processing";

describe("receipt processing policy #1069", () => {
  it.each(["fabrique", "achat"])(
    "requires control and packing for purchased pieces (%s)",
    (category) => {
      expect(processingPolicy({ category, categories: [] })).toBe(
        "PIECES_CONTROLE_EMBALLAGE",
      );
    },
  );
  it("requires the same flow for a material subcontract return", () => {
    expect(
      processingPolicy({
        category: "matiere",
        categories: ["matiere_premiere"],
        orderType: "SOUS_TRAITANCE",
      }),
    ).toBe("PIECES_CONTROLE_EMBALLAGE");
  });
  it("preserves ordinary raw material and consumable policies", () => {
    expect(processingPolicy({ category: "matiere", categories: [] })).toBe(
      "STANDARD",
    );
    expect(
      processingPolicy({ category: "achat", categories: ["consommable"] }),
    ).toBe("STANDARD");
    expect(
      processingPolicy({ category: "achat", categories: [], toolId: 12 }),
    ).toBe("STANDARD");
  });
});

describe("partial processing quantities", () => {
  const q = { received: 100, accepted: 60, packed: 50, stocked: 0 };
  it("permits exactly the 50 packed pieces and keeps independent queues", () => {
    expect(() => assertStockingQuantity(q, 50)).not.toThrow();
    expect(() => assertStockingQuantity(q, 51)).toThrow();
    expect(receiptProcessingState(q, false)).toEqual({
      stage: "TO_STOCK",
      queues: { TO_CONTROL: 40, TO_PACK: 10, TO_STOCK: 50 },
    });
  });
  it("does not permit receipt or quality alone to create stock", () => {
    expect(() => assertStockingQuantity({ ...q, packed: 0 }, 1)).toThrow();
    expect(() =>
      assertPackingQuantity({ ...q, accepted: 0, packed: 0 }, 1),
    ).toThrow();
  });
  it("accounts for previous entries and previous packing", () => {
    expect(() => assertStockingQuantity({ ...q, stocked: 30 }, 21)).toThrow();
    expect(() =>
      assertStockingQuantity({ ...q, stocked: 30 }, 20),
    ).not.toThrow();
    expect(() => assertPackingQuantity(q, 11)).toThrow();
    expect(() => assertPackingQuantity(q, 10)).not.toThrow();
  });
  it.each([0, -1, NaN, Infinity])(
    "rejects invalid command quantities %s",
    (qty) => {
      expect(() => assertPackingQuantity(q, qty)).toThrow();
      expect(() => assertStockingQuantity(q, qty)).toThrow();
    },
  );
  it("keeps blocked and complete states explicit", () => {
    expect(receiptProcessingState(q, true).stage).toBe("BLOCKED");
    expect(
      receiptProcessingState(
        { received: 100, accepted: 100, packed: 100, stocked: 100 },
        false,
      ).stage,
    ).toBe("DONE");
  });
});
