import { describe, expect, it } from "vitest";
import { updatePieceFamilySchema } from "./pieces-families.validators";

describe("updatePieceFamilySchema", () => {
  it("keeps a valid SQL-shaped value as data and strips unrelated fields", () => {
    const parsed = updatePieceFamilySchema.parse({ body: { code: "FAM' OR 1=1 --", unrelated: "ignored" } });
    expect(parsed.body).toEqual({ code: "FAM' OR 1=1 --" });
  });

  it("refuses an empty or oversized patch", () => {
    expect(() => updatePieceFamilySchema.parse({ body: { unknown: true } })).toThrow("Au moins un champ modifiable est requis");
    expect(() => updatePieceFamilySchema.parse({ body: { designation: "x".repeat(256) } })).toThrow("Désignation trop longue");
  });
});
