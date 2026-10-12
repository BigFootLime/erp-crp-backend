import { describe, expect, it, vi } from "vitest";
import { readMaterialBarCountRequirementsTx } from "./material-bar-count-read-model.repository";

describe("count metadata from canonical stock", () => {
  it("distinguishes required bars, tracked geometry and ordinary stock without publishing lengths", async () => {
    const tx = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            { id: "bar", unit: "mm", required: true },
            { id: "other", unit: "mm", required: false },
            { id: "piece", unit: "u", required: false },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ installed: true }] })
        .mockResolvedValueOnce({ rows: [{ id: "tracked" }] }),
    };
    const found = await readMaterialBarCountRequirementsTx(tx as never, [
      { article_id: "bar", stock_batch_id: "untracked" },
      { article_id: "other", stock_batch_id: "tracked" },
      { article_id: "other", stock_batch_id: "ordinary" },
      { article_id: "piece", stock_batch_id: "piece-stock" },
    ]);
    expect(found.get("bar:untracked")).toEqual({
      unit_code: "mm",
      material_bar_count_required: true,
    });
    expect(found.get("other:tracked")?.material_bar_count_required).toBe(true);
    expect(found.get("other:ordinary")?.material_bar_count_required).toBe(
      false,
    );
    expect(found.get("piece:piece-stock")).toEqual({
      unit_code: "u",
      material_bar_count_required: false,
    });
  });
  it("does not query an uninstalled relation or silently turn off a required bar article", async () => {
    const tx = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ id: "bar", unit: "mm", required: true }],
        })
        .mockResolvedValueOnce({ rows: [{ installed: false }] }),
    };
    expect(
      (
        await readMaterialBarCountRequirementsTx(tx as never, [
          { article_id: "bar", stock_batch_id: null },
        ])
      ).get("bar:")?.material_bar_count_required,
    ).toBe(true);
    expect(tx.query).toHaveBeenCalledTimes(2);
  });
  it("makes no queries for empty inventory", async () => {
    const tx = { query: vi.fn() };
    expect(await readMaterialBarCountRequirementsTx(tx as never, [])).toEqual(
      new Map(),
    );
    expect(tx.query).not.toHaveBeenCalled();
  });
});
