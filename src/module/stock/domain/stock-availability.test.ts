import { describe, expect, it } from "vitest";

import {
  calculateStockAvailability,
  evaluateNegativeStockOverride,
} from "./stock-availability";

describe("stock availability", () => {
  it("subtracts reservations and depreciation for released stock", () => {
    expect(
      calculateStockAvailability({
        qty_on_hand: 20,
        qty_reserved: 6,
        qty_depreciated: 2,
        lot_status: "LIBERE",
      })
    ).toEqual({
      qty_on_hand: 20,
      qty_reserved: 6,
      qty_depreciated: 2,
      qty_quarantine: 0,
      qty_blocked: 0,
      qty_available: 12,
    });
  });

  it("keeps non-lot stock eligible", () => {
    expect(
      calculateStockAvailability({
        qty_on_hand: 7,
        qty_reserved: 1,
        qty_depreciated: 0,
        lot_status: null,
      }).qty_available
    ).toBe(6);
  });

  it.each(["EN_ATTENTE", "QUARANTAINE"] as const)(
    "excludes %s stock from availability and exposes quarantine",
    (lotStatus) => {
      const out = calculateStockAvailability({
        qty_on_hand: 9,
        qty_reserved: 1,
        qty_depreciated: 2,
        lot_status: lotStatus,
      });
      expect(out.qty_available).toBe(0);
      expect(out.qty_quarantine).toBe(7);
    }
  );

  it("excludes blocked stock and never returns negative values", () => {
    expect(
      calculateStockAvailability({
        qty_on_hand: 3,
        qty_reserved: 10,
        qty_depreciated: 1,
        lot_status: "BLOQUE",
      })
    ).toMatchObject({ qty_blocked: 2, qty_available: 0 });
  });

  it("allows a bounded negative-stock override only on clean released stock", () => {
    expect(
      evaluateNegativeStockOverride(
        {
          qty_on_hand: 2,
          qty_reserved: 0,
          qty_depreciated: 0,
          lot_status: "LIBERE",
        },
        5,
        { maximum_negative_qty: 4, reason: "Arrêt machine évité" }
      )
    ).toEqual({
      allowed: true,
      projected_qty_on_hand: -3,
      code: "ALLOWED",
    });
  });

  it("refuses overrides that consume reserved stock or exceed the approved floor", () => {
    expect(
      evaluateNegativeStockOverride(
        {
          qty_on_hand: 2,
          qty_reserved: 1,
          qty_depreciated: 0,
          lot_status: null,
        },
        5,
        { maximum_negative_qty: 4, reason: "Dérogation" }
      ).code
    ).toBe("RESERVED_STOCK_PRESENT");

    expect(
      evaluateNegativeStockOverride(
        {
          qty_on_hand: 2,
          qty_reserved: 0,
          qty_depreciated: 0,
          lot_status: null,
        },
        10,
        { maximum_negative_qty: 4, reason: "Dérogation" }
      ).code
    ).toBe("LIMIT_EXCEEDED");
  });
});
