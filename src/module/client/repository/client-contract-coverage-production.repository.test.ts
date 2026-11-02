import { describe, expect, it } from "vitest";
import { remainingIndustrialGoodOutput } from "./client-contract-coverage-production.repository";

describe("yield-aware industrial OF coverage", () => {
  const tagged = {
    coverage_semantics: "GOOD_OUTPUT_V1" as const,
    launched_quantity: 130,
    expected_good_quantity: 104,
    yield_percent: 80,
  };

  it("credits only the expected good output, not the gross launched quantity", () => {
    expect(
      remainingIndustrialGoodOutput({
        launched: "130",
        received: "0",
        good: "0",
        scrap: "0",
        semantics: tagged,
      }).toString(),
    ).toBe("104000000000000");
  });

  it("does not deduct the same real output twice when lots and OF good quantity agree", () => {
    expect(
      remainingIndustrialGoodOutput({
        launched: "130",
        received: "10",
        good: "10",
        scrap: "0",
        semantics: tagged,
      }).toString(),
    ).toBe("94000000000000");
  });

  it("recalculates a manually reduced discrete OF from its frozen 90% yield", () => {
    expect(remainingIndustrialGoodOutput({
      launched: "9", received: "0", good: "0", scrap: "0", unit: "PCE",
      semantics: { coverage_semantics: "GOOD_OUTPUT_V1", launched_quantity: 10, expected_good_quantity: 9, yield_percent: 90 },
    }).toString()).toBe("8000000000000");
  });

  it("recalculates a manually increased discrete OF and subtracts released output once", () => {
    expect(remainingIndustrialGoodOutput({
      launched: "12", received: "2", good: "2", scrap: "0", unit: "PCE",
      semantics: { coverage_semantics: "GOOD_OUTPUT_V1", launched_quantity: 10, expected_good_quantity: 9, yield_percent: 90 },
    }).toString()).toBe("8000000000000");
  });

  it("keeps the initial yield margin when observed scrap stays inside it", () => {
    expect(
      remainingIndustrialGoodOutput({
        launched: "130",
        received: "0",
        good: "0",
        scrap: "5",
        semantics: tagged,
      }).toString(),
    ).toBe("104000000000000");
  });

  it("reduces future conforming output only after observed scrap exceeds the margin", () => {
    expect(
      remainingIndustrialGoodOutput({
        launched: "130",
        received: "0",
        good: "0",
        scrap: "30",
        semantics: tagged,
      }).toString(),
    ).toBe("100000000000000");
  });

  it("preserves legacy OF coverage when no immutable industrial token exists", () => {
    expect(
      remainingIndustrialGoodOutput({
        launched: "130",
        received: "10",
        good: "10",
        scrap: "5",
        semantics: null,
      }).toString(),
    ).toBe("115000000000000");
  });

  it("never falls back to gross launched quantity for a corrupt industrial token", () => {
    expect(
      remainingIndustrialGoodOutput({
        launched: "130",
        received: "0",
        good: "0",
        scrap: "0",
        semantics: {
          coverage_semantics: "GOOD_OUTPUT_V1",
          expected_good_quantity: "104",
          yield_percent: "bad",
        },
      }),
    ).toBe(0n);
  });
});
