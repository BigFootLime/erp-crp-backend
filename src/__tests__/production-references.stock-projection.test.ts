import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  consolidated: vi.fn(),
}));

vi.mock("../config/database", () => ({ default: { query: mocks.query } }));
vi.mock("../module/stock/services/stock.service", () => ({
  listConsolidatedInventorySVC: mocks.consolidated,
}));

import { repoGetReceiptStockReference } from "../module/production/repository/production-references.repository";

const LOT_ID = "11111111-1111-4111-8111-111111111111";
const MOVEMENT_ID = "22222222-2222-4222-8222-222222222222";

describe("OF receipt stock reference projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("proves the OF/movement/lot link then returns only the exact consolidated lot projection", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ lot_id: LOT_ID, lot_code: "LOT-042" }] });
    mocks.consolidated.mockResolvedValue({
      total: 2,
      items: [
        { lot_id: "33333333-3333-4333-8333-333333333333", lot_code: "LOT-042", client_code: "WRONG", article_reference: "WRONG", piece_indice: "0", article_designation: "Wrong", of_references: [], mp_references: [], tr_references: [] },
        { lot_id: LOT_ID, lot_code: "LOT-042", client_code: "CRP-7", article_reference: "PLAN-42", piece_indice: "B", article_designation: "Pièce validée", of_references: ["OF-42"], mp_references: ["MP-1"], tr_references: ["TR-2"] },
      ],
    });

    await expect(repoGetReceiptStockReference({ ofId: 42, movementId: MOVEMENT_ID })).resolves.toEqual({
      lot_id: LOT_ID,
      lot_code: "LOT-042",
      client_code: "CRP-7",
      article_reference: "PLAN-42",
      piece_indice: "B",
      article_designation: "Pièce validée",
      of_references: ["OF-42"],
      mp_references: ["MP-1"],
      tr_references: ["TR-2"],
    });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("receipt.stock_movement_id"), [MOVEMENT_ID, 42]);
    expect(mocks.consolidated).toHaveBeenCalledWith({ lot: "LOT-042", page: 1, pageSize: 200, sortBy: "article_code", sortDir: "asc" });
  });

  it("does not read Stock when the movement is not linked to the OF receipt", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(repoGetReceiptStockReference({ ofId: 42, movementId: MOVEMENT_ID })).rejects.toMatchObject({ code: "OF_RECEIPT_NOT_FOUND" });
    expect(mocks.consolidated).not.toHaveBeenCalled();
  });
});
