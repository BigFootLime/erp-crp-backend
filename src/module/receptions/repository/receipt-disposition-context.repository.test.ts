import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  readReceiptDispositionContext,
  PRE_STOCK_RECEIPT_PREDICATE,
} from "./receipt-disposition-context.repository";
describe("NC receiving context", () => {
  it("does not invent a receiving source for an unbound NC", async () => {
    const query = vi.fn();
    expect(
      await readReceiptDispositionContext(
        { query } as unknown as PoolClient,
        "nc",
        null,
      ),
    ).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it("returns the receipt unit, unprocessed quantity and reconciliation state", async () => {
    const row = {
        receiptLineId: "receipt",
        unit: "u",
        remainingQty: 3,
        reconciliationRequired: true,
      },
      query = vi.fn().mockResolvedValue({ rows: [row] });
    expect(
      await readReceiptDispositionContext(
        { query } as unknown as PoolClient,
        "nc",
        "lot",
      ),
    ).toEqual(row);
    const [sql, args] = query.mock.calls[0];
    expect(args).toEqual(["lot", "nc"]);
    expect(sql).toContain(PRE_STOCK_RECEIPT_PREDICATE);
    expect(sql).toContain("qty_released");
    expect(sql).toContain("d.stock_movement_id IS NULL");
  });
  it("refuses an ambiguous receipt instead of choosing a physical source", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{}, {}] });
    await expect(
      readReceiptDispositionContext(
        { query } as unknown as PoolClient,
        "nc",
        "lot",
      ),
    ).rejects.toMatchObject({ code: "RECEIPT_DISPOSITION_AMBIGUOUS" });
  });
});
