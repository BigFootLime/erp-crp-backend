import { describe, expect, it } from "vitest";
import { computeExecutionQuantities, computeExecutionVerdict, type QualityCharacteristicSpec, type QualitySampleValue } from "../module/qualite/domain/quality-plan";
import { EMPTY_LEDGER, evaluateReleaseRequest, executionReleasableQty } from "../module/qualite/domain/quality-release";

const visual: QualityCharacteristicSpec = {
  key: "ASPECT", position: 1, label: "Aspect", characteristic_type: "VISUAL", value_kind: "BOOLEAN",
  unit: null, nominal: null, tolerance_min: null, tolerance_max: null, precision: null,
  expected_boolean: true, allowed_values: null, criticality: "MAJOR", mandatory: true,
  requires_instrument: false, instrument_category: null, method: null, acceptance_rule: null,
  sampling: { rule: "ALL", value: null, justification: null },
};
const dimension: QualityCharacteristicSpec = { ...visual, key: "LONGUEUR", position: 2, label: "Longueur", characteristic_type: "DIMENSIONAL", value_kind: "NUMERIC", unit: "mm", nominal: 125, tolerance_min: -0.5, tolerance_max: 0.5, expected_boolean: null, requires_instrument: true };
const sample = (key: string, n: number, value: boolean | number | null): QualitySampleValue => ({ characteristic_key: key, sample_no: n, value_numeric: typeof value === "number" ? value : null, value_boolean: typeof value === "boolean" ? value : null, value_text: null, unit: key === "LONGUEUR" ? "mm" : null, evidence_count: 0 });
const visualSamples = [1, 2, 3, 4].map(n => sample("ASPECT", n, true));
const numericSamples = [1, 2, 3, 4].map(n => sample("LONGUEUR", n, 125));
const compute = (samples: QualitySampleValue[], characteristics = [visual, dimension]) => computeExecutionVerdict({ characteristics, samples, population: 4 });

describe("quality execution availability #1173", () => {
  it("does not count four visual-only checks as conforming while mandatory dimensions are missing", () => {
    const verdict = compute(visualSamples);
    expect(verdict.verdict).toBe("EN_ATTENTE");
    expect(verdict.missing).toEqual([{ characteristic_key: "LONGUEUR", expected_samples: 4, recorded_samples: 0 }]);
    expect(computeExecutionQuantities(verdict, 4)).toEqual({ controlled: 4, conforming: 0 });
  });
  it("counts units once after completing all mandatory characteristics", () => {
    const verdict = compute([...visualSamples, ...numericSamples]);
    expect(verdict.verdict).toBe("CONFORME");
    const qty = computeExecutionQuantities(verdict, 4);
    expect(qty).toEqual({ controlled: 4, conforming: 4 });
    expect(executionReleasableQty({ ...EMPTY_LEDGER, population: 4, ...qty }, verdict.verdict)).toBe(4);
  });
  it("preserves the conforming-unit count of a completed partial control", () => {
    const verdict = compute([sample("ASPECT", 1, false), ...visualSamples.slice(1), ...numericSamples]);
    expect(verdict.verdict).toBe("PARTIEL");
    const qty = computeExecutionQuantities(verdict, 4);
    expect(qty).toEqual({ controlled: 4, conforming: 3 });
    expect(executionReleasableQty({ ...EMPTY_LEDGER, population: 4, ...qty, released: 1 }, verdict.verdict)).toBe(2);
  });
  it("does not treat a pending numeric value as a completed mandatory check", () => {
    const verdict = compute([...visualSamples, ...numericSamples.slice(0, 3), sample("LONGUEUR", 4, null)]);
    expect(verdict.verdict).toBe("EN_ATTENTE");
    expect(computeExecutionQuantities(verdict, 4).conforming).toBe(0);
  });
  it("preserves the existing completed fixed-sampling population rule", () => {
    const specs = [visual, dimension].map(spec => ({ ...spec, sampling: { rule: "FIXED" as const, value: 1, justification: "Plan approuvé" } }));
    const verdict = compute([sample("ASPECT", 1, true), sample("LONGUEUR", 1, 125)], specs);
    expect(verdict.verdict).toBe("CONFORME");
    expect(computeExecutionQuantities(verdict, 4)).toEqual({ controlled: 4, conforming: 4 });
  });
  it("reports zero availability for an old incomplete ledger without mutating history", () => {
    const ledger = Object.freeze({ ...EMPTY_LEDGER, population: 4, controlled: 4, conforming: 4 });
    expect(executionReleasableQty(ledger, "EN_ATTENTE")).toBe(0);
    expect(ledger.conforming).toBe(4);
  });
  it("retains the actual incomplete-verdict rejection despite an old positive ledger", () => {
    expect(() => evaluateReleaseRequest({ decision: "FULL", qty: 4, unit: "u", ledger: { ...EMPTY_LEDGER, population: 4, controlled: 4, conforming: 4 }, verdict: "EN_ATTENTE", hasDerogation: false, evidenceCount: 0 })).toThrow(/contrôle incomplet/);
  });
});
