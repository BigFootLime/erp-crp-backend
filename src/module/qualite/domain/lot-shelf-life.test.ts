import { describe, expect, it } from "vitest";
import { isLotExpired } from "./lot-shelf-life";
import { evaluateQualityEligibility, type EligibilityTarget } from "./quality-release";

describe("lot shelf life at the workshop", () => {
  it("is valid throughout the expiry day and expired at the next Paris midnight", () => {
    expect(isLotExpired("2026-10-07", new Date("2026-10-07T21:59:59Z"))).toBe(false);
    expect(isLotExpired("2026-10-07", new Date("2026-10-07T22:00:00Z"))).toBe(true);
    expect(isLotExpired("2026-12-01", new Date("2026-12-01T22:59:59Z"))).toBe(false);
    expect(isLotExpired("2026-12-01", new Date("2026-12-01T23:00:00Z"))).toBe(true);
    expect(isLotExpired(null, new Date())).toBe(false);
  });

  it("blocks operational use but keeps a shipment made before expiry billable", () => {
    const target: EligibilityTarget = { object_type: "LOT", object_id: "lot", label: "Lot", qty_requested: 1,
      lot_status: "LIBERE", expiry_at: "2026-10-06", qty_released: 1, qty_held: 0, qty_consumed: 0,
      open_nc_without_disposition: 0, pending_mandatory_controls: 0, derogation: null };
    const at = new Date("2026-10-07T08:00:00Z");
    expect(evaluateQualityEligibility(target, "RESERVE", at).blocks.map(b => b.code)).toContain("LOT_EXPIRED");
    expect(evaluateQualityEligibility(target, "SHIP", at).allowed).toBe(false);
    expect(evaluateQualityEligibility({ ...target, shelf_life_reference_at: "2026-10-05T10:00:00Z" }, "SHIP", at).allowed).toBe(true);
    expect(evaluateQualityEligibility(target, "INVOICE", at).allowed).toBe(true);
  });
});
