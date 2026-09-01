import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const patchDir = path.resolve(__dirname, "../../db/patches");
const supportDir = path.join(patchDir, "support");
const patch = fs.readFileSync(
  path.join(patchDir, "20260901_stock_inventory_draft_adjustments.sql"),
  "utf8"
);
const repository = fs.readFileSync(
  path.resolve(__dirname, "../module/stock/repository/stock.repository.ts"),
  "utf8"
);

describe("Guided inventory adjustment evidence", () => {
  it("adds an additive snapshot-line link with guarded deployment scripts", () => {
    expect(patch).toMatch(/ADD COLUMN IF NOT EXISTS snapshot_line_id uuid NULL/);
    expect(patch).toMatch(/REFERENCES public\.stock_inventory_snapshot_lines\(id\)/);
    expect(patch).not.toMatch(/DROP\s+TABLE/i);
    expect(patch).not.toMatch(/TRUNCATE/i);
    expect(
      fs.existsSync(path.join(supportDir, "20260901_stock_inventory_draft_adjustments.preflight.sql"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(supportDir, "20260901_stock_inventory_draft_adjustments.verify.sql"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(supportDir, "20260901_stock_inventory_draft_adjustments.rollback.sql"))
    ).toBe(true);
  });

  it("creates or refreshes a DRAFT movement when a discrepancy is saved", () => {
    expect(repository).toMatch(/syncInventoryDraftAdjustment/);
    expect(repository).toMatch(/'ADJUSTMENT','DRAFT'/);
    expect(repository).toMatch(/INVENTORY_DRAFT_UPDATED/);
    expect(repository).toMatch(/draft_adjustment_movement_id/);
  });

  it("posts the existing draft only at close and cancels superseded evidence", () => {
    expect(repository).toMatch(/INVENTORY_DRAFT_MISMATCH/);
    expect(repository).toMatch(/SET status = 'POSTED', posted_at = \$2/);
    expect(repository).toMatch(/INVENTORY_COUNT_MATCHES_SNAPSHOT/);
    expect(repository).toMatch(/INVENTORY_SESSION_CANCELLED/);
    expect(repository).toMatch(/INVENTORY_NO_FINAL_DISCREPANCY/);
  });
});
