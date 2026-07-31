import { describe, expect, it } from "vitest";

import { allocateCommandeStockOldThenNew } from "./stock-scope-allocation";

const ARTICLE = "11111111-1111-1111-1111-111111111111";

describe("allocateCommandeStockOldThenNew", () => {
  it.each([
    { label: "OLD only", old: 10, fresh: 0, expected: { old: 8, fresh: 0, shortage: 0 } },
    { label: "NEW only", old: 0, fresh: 10, expected: { old: 0, fresh: 8, shortage: 0 } },
    { label: "OLD then NEW", old: 3, fresh: 7, expected: { old: 3, fresh: 5, shortage: 0 } },
    { label: "combined shortage", old: 2, fresh: 1, expected: { old: 2, fresh: 1, shortage: 5 } },
    { label: "no stock", old: 0, fresh: 0, expected: { old: 0, fresh: 0, shortage: 8 } },
  ])("allocates $label", ({ old, fresh, expected }) => {
    const [line] = allocateCommandeStockOldThenNew(
      [{ article_id: ARTICLE, requested_qty: 8 }],
      new Map([[ARTICLE, { OLD: old, NEW: fresh }]])
    );

    expect(line).toMatchObject({
      old_used_qty: expected.old,
      new_used_qty: expected.fresh,
      shortage_qty: expected.shortage,
      proposed_production_qty: expected.shortage,
    });
  });

  it("does not reuse availability across repeated lines for the same article", () => {
    const lines = allocateCommandeStockOldThenNew(
      [
        { article_id: ARTICLE, requested_qty: 4 },
        { article_id: ARTICLE, requested_qty: 5 },
      ],
      new Map([[ARTICLE, { OLD: 5, NEW: 2 }]])
    );

    expect(lines[0]).toMatchObject({ old_used_qty: 4, new_used_qty: 0, shortage_qty: 0 });
    expect(lines[1]).toMatchObject({ old_used_qty: 1, new_used_qty: 2, shortage_qty: 2 });
  });
});
