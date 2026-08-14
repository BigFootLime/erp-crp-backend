import { describe, expect, it } from "vitest";

import {
  assessSpcReadiness,
  computeQualityDecisionMetrics,
} from "../module/qualite/domain/quality-intelligence";
import { roleHasQualityCapability } from "../module/qualite/domain/quality-policy";

describe("SOL-22 quality decision metrics", () => {
  it("calcule FPY, PPM et délai sans fausse précision", () => {
    const metrics = computeQualityDecisionMetrics({
      firstPassConformingQty: 8,
      firstPassControlledQty: 10,
      firstPassMissingData: 0,
      defectQty: 25,
      controlledQty: 100_000,
      controlsMissingQuantities: 0,
      closureDurationsDays: [1, 2, 6],
      scrapCost: 125.555,
      reworkCost: 74.445,
      otherPoorQualityCost: 25,
      costCurrency: "EUR",
      costCurrencyCount: 1,
    });

    expect(metrics.find((metric) => metric.code === "FPY")).toMatchObject({
      value: 80,
      numerator: 8,
      denominator: 10,
      reliability: "CONFIRMED",
    });
    expect(metrics.find((metric) => metric.code === "PPM")).toMatchObject({
      value: 250,
      numerator: 25,
      denominator: 100_000,
      reliability: "CONFIRMED",
    });
    expect(metrics.find((metric) => metric.code === "CLOSURE_DELAY")).toMatchObject({
      value: 3,
      unit: "days",
    });
    expect(metrics.find((metric) => metric.code === "COPQ")).toMatchObject({
      value: 225,
      currency: "EUR",
    });
  });

  it("renvoie null, jamais zéro, quand le dénominateur ou le coût manque", () => {
    const metrics = computeQualityDecisionMetrics({
      firstPassConformingQty: 0,
      firstPassControlledQty: 0,
      firstPassMissingData: 0,
      defectQty: 0,
      controlledQty: 0,
      controlsMissingQuantities: 0,
      closureDurationsDays: [],
      scrapCost: null,
      reworkCost: null,
      otherPoorQualityCost: null,
      costCurrency: null,
      costCurrencyCount: 0,
    });

    for (const metric of metrics) {
      expect(metric.value).toBeNull();
      expect(metric.reliability).toBe("UNAVAILABLE");
      expect(metric.missing.length).toBeGreaterThan(0);
    }
  });

  it("marque partiel un ratio contenant des sources historiques incomplètes", () => {
    const metrics = computeQualityDecisionMetrics({
      firstPassConformingQty: 9,
      firstPassControlledQty: 10,
      firstPassMissingData: 2,
      defectQty: 1,
      controlledQty: 10,
      controlsMissingQuantities: 1,
      closureDurationsDays: [1],
      scrapCost: 1,
      reworkCost: 1,
      otherPoorQualityCost: null,
      costCurrency: "EUR",
      costCurrencyCount: 1,
    });
    expect(metrics.find((metric) => metric.code === "FPY")?.reliability).toBe("PARTIAL");
    expect(metrics.find((metric) => metric.code === "PPM")?.reliability).toBe("PARTIAL");
    expect(metrics.find((metric) => metric.code === "COPQ")).toMatchObject({
      value: 2,
      reliability: "PARTIAL",
      missing: ["other_quality_cost_entries"],
    });
  });

  it("refuse d'additionner silencieusement plusieurs devises", () => {
    const copq = computeQualityDecisionMetrics({
      firstPassConformingQty: 1,
      firstPassControlledQty: 1,
      firstPassMissingData: 0,
      defectQty: 0,
      controlledQty: 1,
      controlsMissingQuantities: 0,
      closureDurationsDays: [1],
      scrapCost: 10,
      reworkCost: 5,
      otherPoorQualityCost: null,
      costCurrency: null,
      costCurrencyCount: 2,
    }).find((metric) => metric.code === "COPQ");
    expect(copq).toMatchObject({ value: null, reliability: "UNAVAILABLE" });
    expect(copq?.missing).toContain("currency_conversion_policy");
  });
});

describe("SOL-22 SPC readiness gate", () => {
  it("active SPC uniquement si politique, unité, volume et cadence sont prouvés", () => {
    expect(
      assessSpcReadiness({
        policyActive: true,
        samplingRule: "FIXED",
        expectedUnit: "mm",
        cadenceMinutes: 60,
        subgroupSize: 5,
        minSubgroups: 3,
        observedSubgroups: 4,
        observedUnits: ["mm"],
        cadenceCoverageRatio: 1,
      })
    ).toEqual({ enabled: true, reliability: "CONFIRMED", missing: [] });
  });

  it("reste désactivé si unité ou fréquence n'est pas fiable", () => {
    const result = assessSpcReadiness({
      policyActive: true,
      samplingRule: "FIXED",
      expectedUnit: "mm",
      cadenceMinutes: 60,
      subgroupSize: 5,
      minSubgroups: 3,
      observedSubgroups: 4,
      observedUnits: ["mm", "inch"],
      cadenceCoverageRatio: 0.5,
    });
    expect(result.enabled).toBe(false);
    expect(result.reliability).toBe("PARTIAL");
    expect(result.missing).toEqual(expect.arrayContaining(["consistent_observed_unit", "sampling_cadence_coverage"]));
  });
});

describe("SOL-22 analytics RBAC", () => {
  it("autorise qualité et direction, refuse atelier et comptabilité", () => {
    expect(roleHasQualityCapability("Responsable Qualite", "analytics_read")).toBe(true);
    expect(roleHasQualityCapability("Direction", "analytics_read")).toBe(true);
    expect(roleHasQualityCapability("Chef d'atelier", "analytics_read")).toBe(false);
    expect(roleHasQualityCapability("Comptabilite", "analytics_read")).toBe(false);
  });
});
