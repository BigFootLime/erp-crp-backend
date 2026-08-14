import { describe, expect, it } from "vitest";

import {
  agingBucket,
  assessEInvoiceReadiness,
  classifyDeliveryQueue,
  computeCashForecast,
  computeDsoDays,
  reliabilityFromCoverage,
} from "./adv-reliability";

describe("SOL-23 ADV domain", () => {
  it("prioritizes a structured blocker over lateness and readiness", () => {
    expect(classifyDeliveryQueue({ dueDate: "2026-08-01", asOf: "2026-08-14", remainingQuantity: 2, ready: true, blocked: true })).toBe("BLOCKED");
    expect(classifyDeliveryQueue({ dueDate: "2026-08-01", asOf: "2026-08-14", remainingQuantity: 2, ready: true, blocked: false })).toBe("LATE");
    expect(classifyDeliveryQueue({ dueDate: "2026-08-20", asOf: "2026-08-14", remainingQuantity: 2, ready: true, blocked: false })).toBe("READY");
    expect(classifyDeliveryQueue({ dueDate: null, asOf: "2026-08-14", remainingQuantity: 0, ready: false, blocked: false })).toBe("COMPLETE");
  });

  it("computes DSO in exact cents and returns unavailable without sales denominator", () => {
    expect(computeDsoDays("1000.00", "36500.00")).toBe("10.00");
    expect(computeDsoDays("1000.01", "36500.00")).toBe("10.00");
    expect(computeDsoDays("1000.00", "0.00")).toBeNull();
  });

  it("caps promises and schedules at invoice balance without double counting", () => {
    expect(computeCashForecast({ invoiceId: "42", currency: "EUR", balanceTtc: "100.00", promisedWithinHorizonTtc: "70.00", scheduledWithinHorizonTtc: "80.00" })).toEqual({
      invoice_id: "42", currency: "EUR", promised_ttc: "70.00", scheduled_ttc: "30.00", expected_ttc: "100.00",
    });
    expect(computeCashForecast({ invoiceId: "43", currency: "EUR", balanceTtc: "50.00", promisedWithinHorizonTtc: "70.00", scheduledWithinHorizonTtc: "10.00" }).expected_ttc).toBe("50.00");
  });

  it("keeps missing due dates separate from non-due receivables", () => {
    expect(agingBucket(null, "2026-08-14")).toBe("UNKNOWN");
    expect(agingBucket("2026-08-14", "2026-08-14")).toBe("NOT_DUE");
    expect(agingBucket("2026-07-01", "2026-08-14")).toBe("DUE_31_60");
    expect(agingBucket("2026-01-01", "2026-08-14")).toBe("DUE_91_PLUS");
  });

  it("never invents external e-invoice statuses", () => {
    expect(assessEInvoiceReadiness({ issued: false, legalNumber: null, currency: null, clientId: null, totalTtc: null })).toEqual({ status: "NOT_ASSESSED", missing: [], reliability: "PARTIAL" });
    expect(assessEInvoiceReadiness({ issued: true, legalNumber: null, currency: "EUR", clientId: "001", totalTtc: "120.00" })).toEqual({ status: "BLOCKED", missing: ["LEGAL_NUMBER"], reliability: "PARTIAL" });
    expect(assessEInvoiceReadiness({ issued: true, legalNumber: "FA-2026-1", currency: "EUR", clientId: "001", totalTtc: "120.00" }).status).toBe("READY_FOR_CONNECTOR");
  });

  it("qualifies OTIF reliability from frozen evidence coverage", () => {
    expect(reliabilityFromCoverage(0, 0)).toBe("UNAVAILABLE");
    expect(reliabilityFromCoverage(10, 6)).toBe("PARTIAL");
    expect(reliabilityFromCoverage(10, 10)).toBe("ACTUAL");
  });
});
