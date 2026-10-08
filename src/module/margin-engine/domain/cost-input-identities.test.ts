import { describe, expect, it } from "vitest";
import { composeMarginCostSources } from "./cost-input-identities";
import { calculateMargin, type MarginCostInput, type MarginCalculationInput } from "./margin-engine";

const cost = (key: string, amount: string, category: MarginCostInput["category"] = "PURCHASE"): MarginCostInput => ({
  key, category, availability: "PROVIDED", amount_ht: amount, quantity: null,
  rate: null, rate_unit: null, currency: "EUR",
  evidence: { definition: "Coût de recette", unit: "EUR_HT", period_start: "2026-10-08", period_end: "2026-10-08",
    freshness_at: "2026-10-08T08:00:00Z", source_reliability: "VERIFIED", source_type: "RECIPE_SOURCE", source_ref: key,
    observed_at: "2026-10-08T08:00:00Z", assumption: null, assumption_date: null, rate_version_id: null, rate_id: null,
    rate_effective_at: null, rate_scope_type: null, rate_scope_ref: null, source_document_type: "RECIPE", source_document_ref: key },
});
function calculate(costs: MarginCostInput[]) {
  const input: MarginCalculationInput = { scope_type: "OF", scope_ref: "1", label: "Recette", basis: "ACTUAL",
    as_of: "2026-10-08", revenue: { availability: "PROVIDED", amount_ht: "1000", currency: "EUR", evidence: cost("sale", "1000").evidence },
    costs, required_categories: ["PURCHASE"] };
  return calculateMargin(input);
}

describe("economic cost identity reconciliation", () => {
  it("does not sum an exact collision, retaining both raw amounts and proofs", () => {
    const a = cost("purchase:4", "100"), b = cost("purchase:4", "150");
    const result = calculate([a, b]);
    expect(result.cost_total_ht).toBeNull();
    expect(result.partial_cost_total_ht).toBe("0.00");
    expect(result.missing_inputs.some(row => row.code === "COST_SOURCE_COLLISION")).toBe(true);
    const rows = result.components.find(row => row.category === "PURCHASE")!.inputs;
    expect(rows.map(row => row.amount_ht)).toEqual(["100", "150"]);
    expect(rows.every(row => row.resolved_amount_ht === null)).toBe(true);
    expect(a.evidence.source_reliability).toBe("VERIFIED");
    expect(a.valuation_issue).toBeUndefined();
  });

  it("cannot guess which quote line a legacy purchase or operation amount belongs to", () => {
    for (const kind of ["purchase", "operation"]) {
      const automatic = [cost(`quote-line:1:${kind}:4`, "100"), cost(`quote-line:2:${kind}:4`, "200")];
      const rows = composeMarginCostSources(automatic, [cost(`${kind}:4`, "300")]);
      expect(calculate(rows).cost_total_ht).toBeNull();
      expect(calculate(rows).partial_cost_total_ht).toBe("0.00");
      expect(rows).toHaveLength(3);
    }
  });

  it("keeps the approved invoice cost, excluding a retired receipt's manual amount", () => {
    const rows = composeMarginCostSources([cost("supplier-invoice-line:7", "110")],
      [cost("supplier-receipt:8", "100")], ["supplier-receipt:8"]);
    expect(calculate(rows).partial_cost_total_ht).toBe("110.00");
    expect(calculate(rows).cost_total_ht).toBeNull();
    expect(rows[0].valuation_issue).toBeUndefined();
    expect(rows[1].amount_ht).toBe("100");
  });

  it("lets an explicit retirement clear the stale manual source and keeps independent supplements additive", () => {
    const retired = { ...cost("supplier-receipt:8", "100"), availability: "NOT_APPLICABLE" as const, amount_ht: null };
    const rows = composeMarginCostSources([cost("supplier-invoice-line:7", "110")],
      [retired, cost("freight-extra", "20")], [retired.key]);
    expect(calculate(rows).cost_total_ht).toBe("130.00");
    expect(calculate(rows).gross_margin_ht).toBe("870.00");
  });

  it("does not equate different commercial lines or an unapplied retired key with current sources", () => {
    const rows = composeMarginCostSources([cost("quote-line:1:purchase:4", "100"), cost("quote-line:2:purchase:4", "200")],
      [cost("purchase:5", "50")]);
    expect(calculate(rows).cost_total_ht).toBe("350.00");
  });

  it("does not count a source explicitly marked not applicable as another monetary contribution", () => {
    const active = cost("purchase:4", "100");
    const retired = { ...active, availability: "NOT_APPLICABLE" as const, amount_ht: null };
    expect(calculate([active, retired]).cost_total_ht).toBe("100.00");
  });
});
