import { describe, expect, it } from "vitest";
import {
  MARGIN_COST_CATEGORIES,
  calculateMargin,
  compareMargins,
  type MarginCalculationInput,
  type MarginCostInput,
  type MarginEvidence,
} from "../module/margin-engine/domain/margin-engine";

const EVIDENCE: MarginEvidence = {
  definition: "Valeur de test",
  unit: "EUR_HT",
  period_start: "2026-08-05",
  period_end: "2026-08-05",
  freshness_at: "2026-08-05T08:00:00.000Z",
  source_reliability: "VERIFIED",
  source_type: "TEST",
  source_ref: "TEST_TD_MARGIN_001",
  observed_at: "2026-08-05T08:00:00.000Z",
  assumption: null,
  assumption_date: null,
  rate_version_id: null,
  rate_id: null,
  rate_effective_at: null,
  rate_scope_type: null,
  rate_scope_ref: null,
  source_document_type: "TEST_CASE",
  source_document_ref: "TEST_TD_MARGIN_001",
};

function na(category: MarginCostInput["category"]): MarginCostInput {
  return {
    key: `na:${category}`,
    category,
    availability: "NOT_APPLICABLE",
    amount_ht: null,
    quantity: null,
    rate: null,
    rate_unit: null,
    currency: "EUR",
    evidence: EVIDENCE,
  };
}

function provided(category: MarginCostInput["category"], amount: string): MarginCostInput {
  return { ...na(category), key: `value:${category}`, availability: "PROVIDED", amount_ht: amount };
}

function input(costs: MarginCostInput[], basis: "QUOTED" | "STANDARD" | "UPDATED" | "ACTUAL" = "STANDARD"): MarginCalculationInput {
  return {
    scope_type: "DEVIS",
    scope_ref: "1",
    label: "TEST_TD_MARGIN_001",
    basis,
    as_of: "2026-08-05",
    revenue: { availability: "PROVIDED", amount_ht: "100", currency: "EUR", evidence: EVIDENCE },
    costs,
  };
}

describe("margin engine formulas", () => {
  it("distinguishes gross margin, taux de marge and taux de marque", () => {
    const costs = MARGIN_COST_CATEGORIES.map(na);
    costs.push(provided("MATERIAL", "60"));
    const result = calculateMargin(input(costs));

    expect(result.availability).toBe("COMPLETE");
    expect(result.cost_total_ht).toBe("60.00");
    expect(result.gross_margin_ht).toBe("40.00");
    expect(result.margin_rate_pct).toBe("66.67"); // marge / coût de revient
    expect(result.mark_rate_pct).toBe("40.00"); // marge / prix de vente HT
  });

  it("rounds money half away from zero only at the output boundary", () => {
    const costs = MARGIN_COST_CATEGORIES.map(na);
    costs.push({
      ...provided("MATERIAL", "0"),
      amount_ht: null,
      quantity: "3",
      rate: "0.335",
      rate_unit: "EUR_PER_UNIT",
    });
    const result = calculateMargin(input(costs));
    expect(result.components.find((row) => row.category === "MATERIAL")?.amount_ht).toBe("1.01");
    expect(result.cost_total_ht).toBe("1.01");
  });

  it("applies overhead percentage to known direct costs", () => {
    const costs = MARGIN_COST_CATEGORIES.map(na);
    costs.push(provided("MATERIAL", "50"), provided("OPERATOR", "50"));
    costs.push({
      ...provided("OVERHEAD", "0"),
      amount_ht: null,
      quantity: null,
      rate: "10",
      rate_unit: "PERCENT_OF_DIRECT_COST",
    });
    const result = calculateMargin(input(costs));
    expect(result.components.find((row) => row.category === "OVERHEAD")?.amount_ht).toBe("10.00");
    expect(result.cost_total_ht).toBe("110.00");
  });

  it("never converts missing cost inputs into zero or a real margin", () => {
    const result = calculateMargin(input([provided("MATERIAL", "10")]));
    expect(result.availability).toBe("PARTIAL");
    expect(result.partial_cost_total_ht).toBe("10.00");
    expect(result.cost_total_ht).toBeNull();
    expect(result.gross_margin_ht).toBeNull();
    expect(result.missing_inputs.map((row) => row.category)).toContain("MACHINE");
  });

  it("keeps a category incomplete when any rate-driven entry is unresolved", () => {
    const costs = MARGIN_COST_CATEGORIES.map(na);
    costs.push(provided("OPERATOR", "25"));
    costs.push({
      ...provided("OPERATOR", "0"),
      key: "operator:unresolved-rate",
      amount_ht: null,
      quantity: null,
      rate: "50",
      rate_unit: "EUR_PER_HOUR",
    });
    const result = calculateMargin(input(costs));
    expect(result.components.find((row) => row.category === "OPERATOR")?.status).toBe("MISSING");
    expect(result.cost_total_ht).toBeNull();
    expect(result.missing_inputs.map((row) => row.code)).toContain("OPERATOR_MISSING");
  });

  it("uses the frozen operation cost once after preparation, quantity and coefficient", () => {
    // 0.5 h préparation + (0.1 h × 10 pièces × coef 1.5) = 2 h; 2 h × 50 €/h = 100 €.
    // `cout_mo=100` est déjà ce total autoritaire : la quantité du devis ne doit pas le remultiplier.
    const costs = MARGIN_COST_CATEGORIES.map(na);
    costs.push(provided("OPERATOR", "100"));
    const result = calculateMargin(input(costs));
    expect(result.components.find((row) => row.category === "OPERATOR")?.amount_ht).toBe("100.00");
    expect(result.cost_total_ht).toBe("100.00");
  });

  it("computes actual/standard variance only when both calculations are complete", () => {
    const complete = MARGIN_COST_CATEGORIES.map(na);
    const quoted = calculateMargin(input([...complete, provided("MATERIAL", "60")], "QUOTED"));
    const standard = calculateMargin(input([...complete, provided("MATERIAL", "60")], "STANDARD"));
    const updated = calculateMargin(input([...complete, provided("MATERIAL", "62")], "UPDATED"));
    const actual = calculateMargin(input([...complete, provided("MATERIAL", "65")], "ACTUAL"));
    expect(compareMargins(quoted, standard, updated, actual).variances.actual_vs_standard).toMatchObject({
      available: true,
      cost_ht: "5.00",
      gross_margin_ht: "-5.00",
    });

    const partialActual = calculateMargin(input([provided("MATERIAL", "65")], "ACTUAL"));
    expect(compareMargins(quoted, standard, updated, partialActual).variances.actual_vs_standard.available).toBe(false);
  });

  it("publishes reliability and a server-side waterfall without inventing missing steps", () => {
    const complete = MARGIN_COST_CATEGORIES.map(na);
    const actual = calculateMargin(input([
      ...complete,
      provided("MATERIAL", "20"),
      provided("OPERATOR", "30"),
      provided("SUBCONTRACTING", "10"),
    ], "ACTUAL"));
    expect(actual.reliability).toBe("ACTUAL");
    expect(actual.waterfall.map((row) => [row.code, row.amount_ht, row.running_total_ht])).toEqual([
      ["PRICE", "100.00", "100.00"],
      ["MATERIAL", "-20.00", "80.00"],
      ["TIME", "-30.00", "50.00"],
      ["SUBCONTRACTING", "-10.00", "40.00"],
      ["SCRAP_REWORK", "0.00", "40.00"],
      ["OTHER", "0.00", "40.00"],
      ["MARGIN", "40.00", "40.00"],
    ]);
    const partial = calculateMargin(input([provided("MATERIAL", "20")], "ACTUAL"));
    expect(partial.reliability).toBe("PARTIAL");
    expect(partial.waterfall.find((row) => row.code === "TIME")?.amount_ht).toBeNull();
  });

  it("publishes the oldest source freshness as the calculation freshness", () => {
    const oldCost = {
      ...provided("MATERIAL", "20"),
      evidence: { ...EVIDENCE, freshness_at: "2026-08-01T08:00:00.000Z" },
    };
    const result = calculateMargin(input([...MARGIN_COST_CATEGORIES.map(na), oldCost]));
    expect(result.freshness_at).toBe("2026-08-01T08:00:00.000Z");
  });
});
