import { describe, expect, it } from "vitest";
import { applyOpeningStockTx } from "./openings.contract";
import type { CutoverRow } from "../../types/data-cutover.types";

const row = (values: CutoverRow["values"]): CutoverRow => ({
  id: "row-1", batch_id: "batch", domain: "OPENING_STOCK", legacy_key: "STOCK:1", source_id: "source", sheet: "Stock", row_number: 3,
  source_values: values, values, source_issues: [], source_notes: [], decision: "INCLUDE", review_note: "confirmed", version: 1, status: "READY", issues: [],
});
const base = { stockScope: "OLD", stockKind: "MP", articleReference: "MAT-1", quantityCounted: "2.5", quantityReserved: "0", unit: "kg", warehouse: "MAG", location: "A1", qualityStatus: "QUARANTAINE", owner: "CRP", lotReference: "L-1", countEvidence: "Comptage signé" };

describe("cutover opening stock contract", () => {
  it("fails closed before any native write when a reservation or value needs a separate native target", async () => {
    const client = {} as never;
    const targets = new Map([["OPENING_STOCK:STOCK:1", { id: "article-1", reference: "MAT-1", type: "ARTICLE" }]]);
    const audit = { user_id: 1 } as never;
    await expect(applyOpeningStockTx({ client, targets, audit, idempotencyKeyFor: () => "cutover-opening-1", rows: [row({ ...base, quantityReserved: "1" })] })).rejects.toMatchObject({ code: "CUTOVER_STOCK_RESERVATION_TARGET_REQUIRED" });
    await expect(applyOpeningStockTx({ client, targets, audit, idempotencyKeyFor: () => "cutover-opening-2", rows: [row({ ...base, valuationUnitPrice: "42" })] })).rejects.toMatchObject({ code: "CUTOVER_STOCK_VALUE_BASIS_REQUIRED" });
  });
});
