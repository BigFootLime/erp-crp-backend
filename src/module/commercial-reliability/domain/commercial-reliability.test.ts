import { describe, expect, it } from "vitest";
import {
  commercialPayloadHash,
  conversionRate,
  effectiveDiscountPct,
  orderAgingBucket,
  qualifyCommercialRisk,
} from "./commercial-reliability";

describe("SOL-17 commercial reliability rules", () => {
  it("qualifies risk from source facts without an invented score", () => {
    expect(qualifyCommercialRisk({
      clientBlocked: true,
      overdueReceivablesTtc: 0,
      overdueBacklogHt: 0,
      blockedOrders: 0,
      expiredOpenQuotes: 0,
    })).toMatchObject({ level: "CRITICAL", reliability: "ACTUAL", factors: ["CLIENT_BLOCKED"] });

    expect(qualifyCommercialRisk({
      clientBlocked: false,
      overdueReceivablesTtc: 0,
      overdueBacklogHt: 120,
      blockedOrders: 0,
      expiredOpenQuotes: 0,
      missingFinancialPermission: true,
    })).toMatchObject({ level: "MEDIUM", reliability: "PARTIAL" });
  });

  it("keeps undated promises separate from zero lateness", () => {
    expect(orderAgingBucket(null, "2026-08-12")).toBe("UNDATED");
    expect(orderAgingBucket("2026-08-12", "2026-08-12")).toBe("NOT_DUE");
    expect(orderAgingBucket("2026-07-13", "2026-08-12")).toBe("1_30");
    expect(orderAgingBucket("2026-05-01", "2026-08-12")).toBe("90_PLUS");
  });

  it("uses stable request hashes and honest null denominators", () => {
    expect(commercialPayloadHash({ b: 2, a: 1 })).toBe(commercialPayloadHash({ a: 1, b: 2 }));
    expect(conversionRate(0, 0)).toBeNull();
    expect(conversionRate(1, 4)).toBe(25);
    expect(effectiveDiscountPct({ grossAmountHt: 100, netAmountHt: 90 })).toBe(10);
    expect(effectiveDiscountPct({ grossAmountHt: 0, netAmountHt: 10 })).toBeNull();
  });
});
