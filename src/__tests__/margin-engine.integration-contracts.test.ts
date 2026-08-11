import fs from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../utils/httpError";
import { calculateMargin, compareMargins, type MarginEvidence } from "../module/margin-engine/domain/margin-engine";
import {
  isMarginRateResolutionValid,
  rateUnitMatchesCategory,
  validateRateForInput,
  type ManualInputRow,
} from "../module/margin-engine/repository/margin-engine.repository";
import { assertCurrentMarginDate, renderMarginCsv } from "../module/margin-engine/services/margin-engine.service";
import { createMarginInputSchema } from "../module/margin-engine/validators/margin-engine.validators";
import { repoRoot } from "./helpers/repo-paths";

const rateRow: ManualInputRow = {
  input_key: "operator-rate",
  input_kind: "COST",
  category: "OPERATOR",
  availability: "PROVIDED",
  amount_ht: null,
  quantity: "2",
  currency: "EUR",
  source_type: "RATE_INPUT",
  source_ref: "OF-42",
  observed_at: "2026-08-05T08:00:00.000Z",
  assumption: null,
  assumption_date: null,
  rate_id: "11111111-1111-4111-8111-111111111111",
  rate_effective_at: "2026-08-05",
  rate_validation_snapshot: {
    rate_id: "11111111-1111-4111-8111-111111111111",
    rate_version_id: "22222222-2222-4222-8222-222222222222",
    category: "OPERATOR",
    unit: "EUR_PER_HOUR",
    scope_type: "GLOBAL",
    scope_ref: null,
    rate_effective_at: "2026-08-05",
    validated_scope_type: "OF",
    validated_scope_ref: "42",
  },
  rate_amount: "50.000000",
  rate_unit: "EUR_PER_HOUR",
  rate_version_id: "22222222-2222-4222-8222-222222222222",
  rate_category: "OPERATOR",
  rate_scope_type: "GLOBAL",
  rate_scope_ref: null,
  rate_effective_from: "2026-01-01",
  rate_effective_to: "2026-12-31",
  created_by: 7,
  definition: "Temps opérateur constaté",
  unit: "HOUR",
  period_start: "2026-08-05",
  period_end: "2026-08-05",
  source_reliability: "VERIFIED",
  source_document_type: "OF_OPERATION",
  source_document_ref: "42",
};

describe("margin rate resolution", () => {
  it("validates category, unit, quantity, scope proof and effective period at read time", () => {
    expect(isMarginRateResolutionValid(rateRow, "OF", "42")).toBe(true);
    expect(isMarginRateResolutionValid({ ...rateRow, quantity: null }, "OF", "42")).toBe(false);
    expect(isMarginRateResolutionValid({ ...rateRow, rate_category: "MACHINE" }, "OF", "42")).toBe(false);
    expect(isMarginRateResolutionValid({ ...rateRow, rate_effective_at: "2027-01-01" }, "OF", "42")).toBe(false);
    expect(isMarginRateResolutionValid(rateRow, "OF", "43")).toBe(false);
    expect(isMarginRateResolutionValid({ ...rateRow, rate_validation_snapshot: null }, "OF", "42")).toBe(false);
  });

  it("rejects incoherent category/unit pairs", () => {
    expect(rateUnitMatchesCategory("EUR_PER_HOUR", "OPERATOR")).toBe(true);
    expect(rateUnitMatchesCategory("EUR_PER_HOUR", "MATERIAL")).toBe(false);
    expect(rateUnitMatchesCategory("PERCENT_OF_DIRECT_COST", "OVERHEAD")).toBe(true);
    expect(rateUnitMatchesCategory("PERCENT_OF_DIRECT_COST", "TRANSPORT")).toBe(false);
  });

  it("validates category, unit, period and business scope atomically at creation", async () => {
    const input = createMarginInputSchema.parse({
      scope_type: "OF", scope_ref: "42", basis: "ACTUAL", input_key: "operator-rate",
      input_kind: "COST", category: "OPERATOR", availability: "PROVIDED",
      quantity: 2, rate_id: rateRow.rate_id, rate_effective_at: "2026-08-05", source_type: "RATE_INPUT",
      definition: "Temps opérateur valorisé", unit: "HOUR",
      period_start: "2026-08-05", period_end: "2026-08-05", source_reliability: "DECLARED",
    });
    const globalRate = {
      id: rateRow.rate_id!, category: "OPERATOR" as const, unit: "EUR_PER_HOUR" as const,
      scope_type: "GLOBAL", scope_ref: null, rate_version_id: rateRow.rate_version_id!,
      effective_from: "2026-01-01", effective_to: "2026-12-31",
    };
    const tx = { query: vi.fn().mockResolvedValue({ rows: [globalRate] }) } as unknown as PoolClient;
    await expect(validateRateForInput(tx, input, 7)).resolves.toMatchObject({
      category: "OPERATOR", unit: "EUR_PER_HOUR", validated_scope_type: "OF", validated_scope_ref: "42",
    });

    const wrongCategoryTx = { query: vi.fn().mockResolvedValue({ rows: [{ ...globalRate, category: "MACHINE" }] }) } as unknown as PoolClient;
    await expect(validateRateForInput(wrongCategoryTx, input, 7)).rejects.toMatchObject({ code: "MARGIN_RATE_CATEGORY_UNIT_MISMATCH" });

    const expiredTx = { query: vi.fn().mockResolvedValue({ rows: [{ ...globalRate, effective_to: "2026-07-31" }] }) } as unknown as PoolClient;
    await expect(validateRateForInput(expiredTx, input, 7)).rejects.toMatchObject({ code: "MARGIN_RATE_OUTSIDE_EFFECTIVE_PERIOD" });

    const scopedTx = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ ...globalRate, scope_type: "PIECE_TECHNIQUE", scope_ref: "33333333-3333-4333-8333-333333333333" }] })
        .mockResolvedValueOnce({ rows: [{ matches: false }] }),
    } as unknown as PoolClient;
    await expect(validateRateForInput(scopedTx, input, 7)).rejects.toMatchObject({ code: "MARGIN_RATE_SCOPE_MISMATCH" });
  });
});

describe("margin historical contract", () => {
  it("refuses to recalculate a past state from mutable current sources", () => {
    try {
      assertCurrentMarginDate("2000-01-01");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe("MARGIN_HISTORICAL_RECALCULATION_FORBIDDEN");
      return;
    }
    throw new Error("Historical recalculation should have been rejected");
  });
});

describe("margin governed CSV", () => {
  it("exports evidence, dated assumptions, rate proof, missing inputs, measurements and as_of", () => {
    const revenueEvidence: MarginEvidence = {
      definition: "Prix de vente HT", unit: "EUR_HT", period_start: "2026-08-05", period_end: "2026-08-05",
      freshness_at: "2026-08-05T08:00:00Z", source_reliability: "VERIFIED",
      source_type: "DEVIS_TOTAL_HT", source_ref: "7", observed_at: "2026-08-05T08:00:00Z",
      assumption: null, assumption_date: null, rate_version_id: null, rate_id: null,
      rate_effective_at: null, rate_scope_type: null, rate_scope_ref: null,
      source_document_type: "DEVIS", source_document_ref: "7",
    };
    const costEvidence: MarginEvidence = {
      definition: "Temps opérateur valorisé", unit: "EUR_HT", period_start: "2026-08-05", period_end: "2026-08-05",
      freshness_at: "2026-08-05T09:00:00Z", source_reliability: "DECLARED",
      source_type: "RATE_INPUT", source_ref: "OF-42", observed_at: "2026-08-05T09:00:00Z",
      assumption: "Budget validé", assumption_date: "2026-08-01",
      rate_id: rateRow.rate_id, rate_version_id: rateRow.rate_version_id,
      rate_effective_at: rateRow.rate_effective_at, rate_scope_type: "GLOBAL", rate_scope_ref: null,
      source_document_type: "OF", source_document_ref: "42",
    };
    const base = {
      scope_type: "OF" as const, scope_ref: "42", label: "TEST_TD_MARGIN_42",
      as_of: "2026-08-05", revenue: { availability: "PROVIDED" as const, amount_ht: "100", currency: "EUR", evidence: revenueEvidence },
      costs: [{
        key: "operator-rate", category: "OPERATOR" as const, availability: "PROVIDED" as const,
        amount_ht: "25", quantity: null, rate: null, rate_unit: null, currency: "EUR", evidence: costEvidence,
      }],
      measurements: { actual_hours: "2.0" },
    };
    const quoted = calculateMargin({ ...base, basis: "QUOTED" });
    const standard = calculateMargin({ ...base, basis: "STANDARD" });
    const updated = calculateMargin({ ...base, basis: "UPDATED" });
    const actual = calculateMargin({ ...base, basis: "ACTUAL" });
    const csv = renderMarginCsv({ ...compareMargins(quoted, standard, updated, actual), generated_at: "2026-08-05T10:00:00Z" });

    for (const expected of [
      "definition", "unit", "period_start", "period_end", "source_reliability",
      "source_type", "observed_at", "assumption_date", "rate_version_id", "rate_effective_at",
      "missing_code", "measurement_key", "as_of", "DEVIS_TOTAL_HT", "Budget validé",
      "MACHINE_MISSING", "actual_hours", "2026-08-05",
    ]) expect(csv).toContain(expected);

    const lines = csv.trim().replace(/^\ufeff/, "").split("\r\n");
    const width = lines[0]!.split(";").length;
    expect(lines.slice(1).every((line) => line.split(";").length === width)).toBe(true);
  });
});

describe("margin mutation audit contract", () => {
  it("writes audit through the same transaction before every business commit", () => {
    const source = fs.readFileSync(path.join(repoRoot, "src", "module", "margin-engine", "repository", "margin-engine.repository.ts"), "utf8");
    expect(source).toMatch(/repoInsertAuditLog\(\{[\s\S]*?tx,/);
    expect(source).toMatch(/MARGIN_INPUT_VERSION_CREATED[\s\S]*?client\.query\("COMMIT"\)/);
    expect(source).toMatch(/MARGIN_RATE_VERSION_CREATED[\s\S]*?client\.query\("COMMIT"\)/);
    expect(source).toMatch(/MARGIN_RECALCULATION_SNAPSHOTTED[\s\S]*?client\.query\("COMMIT"\)/);
  });

  it("revalidates a versioned rate scope against the live target when reading inputs", () => {
    const source = fs.readFileSync(path.join(repoRoot, "src", "module", "margin-engine", "repository", "margin-engine.repository.ts"), "utf8");
    expect(source).toMatch(/rateResolved\s*=\s*await scopedRateMatchesTarget\(\s*pool,/s);
    expect(source).toContain("row.created_by");
  });
});
