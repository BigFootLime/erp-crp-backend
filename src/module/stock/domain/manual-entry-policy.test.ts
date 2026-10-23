import { describe, expect, it } from "vitest";
import { assertStockEntrySource } from "./manual-entry-policy";

describe("stock entry source", () => {
  it("rejects a generic manual entry with an actionable workflow", () => {
    expect(() => assertStockEntrySource({ movementType: "IN" })).toThrow(/Base OLD/);
  });
  it("preserves trusted receipt/fabrication flows", () => {
    expect(() => assertStockEntrySource({ movementType: "IN", trustedSource: true })).not.toThrow();
  });
  it("preserves a controlled compensating entry", () => {
    expect(() => assertStockEntrySource({ movementType: "IN", reversalOfId: "original-movement" })).not.toThrow();
  });
  it.each(["OUT", "TRANSFER", "ADJUSTMENT", "SCRAP"])("preserves %s", movementType => {
    expect(() => assertStockEntrySource({ movementType })).not.toThrow();
  });
});
