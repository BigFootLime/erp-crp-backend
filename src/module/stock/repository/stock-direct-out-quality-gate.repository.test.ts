import { beforeEach, describe, expect, it, vi } from "vitest";

const { qualityGate } = vi.hoisted(() => ({ qualityGate: vi.fn() }));

vi.mock("../../qualite/repository/quality-operational-gate.repository", () => ({
  assertOperationalLotQualityEligibility: qualityGate,
}));

import { assertDirectOutMovementQualityEligibility, assertStockConsumptionAllowed, isMaterialRemnantReversalTx, type LockedStockState } from "./stock.repository";

const LOT_A = "00000000-0000-4000-8000-000000000616";
const LOT_B = "00000000-0000-4000-8000-000000000617";

describe("direct OUT Quality 360 repository boundary", () => {
  beforeEach(() => qualityGate.mockReset());

  it("aggregates each physical lot and calls the gate before posting", async () => {
    qualityGate.mockResolvedValue({});

    await assertDirectOutMovementQualityEligibility({
      client: { query: vi.fn() } as never,
      lines: [
        { lot_id: LOT_A, qty: 2, unite: "PCS" },
        { lot_id: LOT_A, qty: 3, unite: "PCS" },
        { lot_id: LOT_B, qty: 1, unite: "KG" },
      ],
    });

    expect(qualityGate).toHaveBeenCalledTimes(2);
    expect(qualityGate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      lotId: LOT_A, qty: 5, unit: "PCS", purpose: "RESERVE",
    }));
    expect(qualityGate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      lotId: LOT_B, qty: 1, unit: "KG", purpose: "RESERVE",
    }));
  });

  it("fails before an OUT can post when Quality rejects the lot", async () => {
    qualityGate.mockRejectedValueOnce(Object.assign(new Error("blocked"), { code: "QUALITY_NOT_ELIGIBLE" }));

    await expect(assertDirectOutMovementQualityEligibility({
      client: { query: vi.fn() } as never,
      lines: [{ lot_id: LOT_A, qty: 1, unite: "PCS" }],
    })).rejects.toMatchObject({ code: "QUALITY_NOT_ELIGIBLE" });
  });

  it("rejects mixed units for a single lot instead of summing incomparable quantities", async () => {
    await expect(assertDirectOutMovementQualityEligibility({
      client: { query: vi.fn() } as never,
      lines: [{ lot_id: LOT_A, qty: 1, unite: "PCS" }, { lot_id: LOT_A, qty: 1, unite: "KG" }],
    })).rejects.toMatchObject({ code: "QUALITY_MOVEMENT_UNIT_AMBIGUOUS" });
    expect(qualityGate).not.toHaveBeenCalled();
  });
});

describe('unreleased remnant correction boundary', () => {
  const state: LockedStockState = {stock_level_id:'level',stock_batch_id:'batch',qty_on_hand:.5,qty_reserved:0,qty_depreciated:0,lot_status:'EN_ATTENTE'};
  it('keeps ordinary issues and unproved negative adjustments blocked', () => {
    for (const type of ['OUT','ADJUSTMENT'] as const)
      expect(()=>assertStockConsumptionAllowed(state,{movement_type:type,qty:-.5})).toThrow(expect.objectContaining({code:'LOT_NOT_RELEASED'}));
    expect(()=>assertStockConsumptionAllowed(state,{movement_type:'OUT',qty:.5,allow_nonreleased_adjustment:true})).toThrow(expect.objectContaining({code:'LOT_NOT_RELEASED'}));
  });
  it('allows the exact physical correction but never takes reserved or missing stock', () => {
    expect(()=>assertStockConsumptionAllowed(state,{movement_type:'ADJUSTMENT',qty:-.5,allow_nonreleased_adjustment:true})).not.toThrow();
    for (const unavailable of [{...state,qty_reserved:.1},{...state,qty_on_hand:.4}])
      expect(()=>assertStockConsumptionAllowed(unavailable,{movement_type:'ADJUSTMENT',qty:-.5,allow_nonreleased_adjustment:true})).toThrow(expect.objectContaining({code:'INSUFFICIENT_STOCK'}));
  });
  it('requires exactly one persisted remnant reversal proof', async () => {
    const client={query:vi.fn().mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{id:'proof'}]})};
    expect(await isMaterialRemnantReversalTx(client as never,'movement')).toBe(false);
    expect(await isMaterialRemnantReversalTx(client as never,'movement')).toBe(true);
  });
});
