import { describe, expect, it } from "vitest";

import {
  buildStockProjection,
  classifyAbc,
  historicalCoverageWeeks,
  inventoryAccuracy,
  stockTurnoverPerYear,
  summarizeStockValues,
} from "./stock-intelligence";

describe("SOL-19 stock intelligence calculations", () => {
  it("projects a dated shortage and shows the no-write proposal effect", () => {
    const projection = buildStockProjection({
      as_of: "2026-08-13",
      weeks: 13,
      initial_usable_qty: 10,
      demands: [
        { date: "2026-08-14", quantity: 6, source: "OF OF-42", reference: "42" },
        { date: "2026-08-20", quantity: 8, source: "OF OF-43", reference: "43" },
      ],
      receipts: [
        { date: "2026-08-19", quantity: 2, source: "BCF-26-12", reference: "12" },
      ],
      simulated_receipt: {
        date: "2026-08-18",
        quantity: 5,
        source: "SIMULATION",
        reference: null,
      },
    });

    expect(projection.shortage_without_proposal).toBe("2026-08-20");
    expect(projection.shortage_with_proposal).toBeNull();
    expect(projection.points[0]).toMatchObject({
      demand_qty: 6,
      expected_receipt_qty: 2,
      simulated_receipt_qty: 5,
      stock_without_proposal: 6,
      stock_with_proposal: 11,
      reliability: "ACTUAL",
    });
    expect(projection.points[1]).toMatchObject({
      demand_qty: 8,
      expected_receipt_qty: 0,
      simulated_receipt_qty: 0,
      stock_without_proposal: -2,
      stock_with_proposal: 3,
    });
  });

  it("never turns an absent starting stock into zero", () => {
    const projection = buildStockProjection({
      as_of: "2026-08-13",
      weeks: 2,
      initial_usable_qty: null,
      demands: [],
      receipts: [],
    });
    expect(projection.points.every((point) => point.stock_without_proposal === null)).toBe(true);
    expect(projection.points.every((point) => point.reliability === "UNAVAILABLE")).toBe(true);
    expect(projection.missing).toContain("STARTING_USABLE_STOCK");
  });

  it("marks invalid event evidence instead of subtracting a manufactured zero", () => {
    const projection = buildStockProjection({
      as_of: "2026-08-13",
      weeks: 1,
      initial_usable_qty: 5,
      demands: [{ date: "invalid", quantity: 4, source: "OF", reference: null }],
      receipts: [],
    });
    expect(projection.points[0].stock_without_proposal).toBe(5);
    expect(projection.points[0].reliability).toBe("PARTIAL");
    expect(projection.missing).toContain("DEMAND_QUANTITY_OR_DATE");
  });

  it("brings overdue active demand into the first week and marks the projection partial", () => {
    const projection = buildStockProjection({
      as_of: "2026-08-13",
      weeks: 2,
      initial_usable_qty: 5,
      demands: [{ date: "2026-08-10", quantity: 7, source: "OF en retard", reference: "42" }],
      receipts: [],
    });
    expect(projection.shortage_without_proposal).toBe("2026-08-13");
    expect(projection.points[0]).toMatchObject({ demand_qty: 7, stock_without_proposal: -2, reliability: "PARTIAL" });
    expect(projection.missing).toContain("PAST_DUE_DEMAND");
  });

  it("marks every projected week partial when an active event is outside the horizon", () => {
    const projection = buildStockProjection({
      as_of: "2026-08-13",
      weeks: 1,
      initial_usable_qty: 5,
      demands: [{ date: "2026-09-01", quantity: 2, source: "OF futur", reference: "43" }],
      receipts: [],
    });
    expect(projection.points[0].reliability).toBe("PARTIAL");
    expect(projection.missing).toContain("EVENT_OUTSIDE_HORIZON");
  });

  it("classifies ABC by cumulative consumption value with stable tie ordering", () => {
    expect(classifyAbc([
      { key: "B", consumption_value: 15 },
      { key: "A", consumption_value: 80 },
      { key: "D", consumption_value: null },
      { key: "C", consumption_value: 5 },
    ], 80, 95)).toEqual([
      { key: "B", classification: "B", cumulative_pct: 95 },
      { key: "A", classification: "A", cumulative_pct: 80 },
      { key: "D", classification: null, cumulative_pct: null },
      { key: "C", classification: "C", cumulative_pct: 100 },
    ]);
  });

  it("rejects incoherent ABC thresholds", () => {
    expect(() => classifyAbc([], 95, 80)).toThrow(/ABC thresholds/);
  });

  it("computes quantity turnover and coverage without dividing missing or zero evidence", () => {
    expect(stockTurnoverPerYear({ outbound_qty: 100, current_usable_qty: 25, lookback_days: 365 })).toBe(4);
    expect(stockTurnoverPerYear({ outbound_qty: 100, current_usable_qty: 0, lookback_days: 365 })).toBeNull();
    expect(stockTurnoverPerYear({ outbound_qty: null, current_usable_qty: 25, lookback_days: 365 })).toBeNull();
    expect(historicalCoverageWeeks({ current_available_qty: 26, consumed_qty: 52, lookback_days: 91 })).toBe(6.5);
    expect(historicalCoverageWeeks({ current_available_qty: 26, consumed_qty: 0, lookback_days: 91 })).toBeNull();
  });

  it("measures inventory accuracy with percentage and absolute tolerances", () => {
    expect(inventoryAccuracy({
      lines: [
        { theoretical_qty: 100, counted_qty: 100.4 },
        { theoretical_qty: 10, counted_qty: 10.2 },
        { theoretical_qty: 0, counted_qty: 0.001 },
        { theoretical_qty: null, counted_qty: 2 },
      ],
      tolerance_pct: 0.5,
      absolute_tolerance_qty: 0.001,
    })).toEqual({ value: 66.67, exact_lines: 2, counted_lines: 3, missing_lines: 1 });
  });

  it("never adds stock values expressed in different currencies", () => {
    expect(summarizeStockValues([
      { value: 100, currency: "EUR" },
      { value: 50, currency: "USD" },
    ])).toEqual({
      value: null,
      unit: "devises multiples",
      reliability: "UNAVAILABLE",
      missing: ["STOCK_VALUE_CURRENCY_CONFLICT"],
    });
    expect(summarizeStockValues([
      { value: 100, currency: "EUR" },
      { value: null, currency: "EUR" },
    ])).toEqual({
      value: 100,
      unit: "EUR",
      reliability: "PARTIAL",
      missing: ["UNVALUED_STOCK_SCOPES"],
    });
  });
});
