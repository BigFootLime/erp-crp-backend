import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSourceFunction } from "./helpers/source-contract";

const patchDir = path.resolve(__dirname, "../../db/patches");
const supportDir = path.join(patchDir, "support");
const patch = fs.readFileSync(
  path.join(patchDir, "20260901_stock_inventory_draft_adjustments.sql"),
  "utf8"
);
const owner = "src/module/stock/repository/stock-inventory-sessions.repository.ts";
const saveCount = readSourceFunction(owner, "repoUpsertInventoryLine");
const draftAdjustment = readSourceFunction(owner, "syncInventoryDraftAdjustment");
const closeInventory = readSourceFunction(owner, "repoCloseInventorySession");
const cancelInventory = readSourceFunction(owner, "repoCancelInventorySession");

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
    expect(saveCount).toMatch(/syncInventoryDraftAdjustment/);
    expect(draftAdjustment).toMatch(/'ADJUSTMENT','DRAFT'/);
    expect(draftAdjustment).toMatch(/INVENTORY_DRAFT_UPDATED/);
    expect(saveCount).toMatch(/draft_adjustment_movement_id/);
  });

  it("posts the existing draft only at close and cancels superseded evidence", () => {
    expect(closeInventory).toMatch(/INVENTORY_DRAFT_MISMATCH/);
    expect(closeInventory).toMatch(/SET status = 'POSTED', posted_at = \$2/);
    expect(draftAdjustment).toMatch(/INVENTORY_COUNT_MATCHES_SNAPSHOT/);
    expect(cancelInventory).toMatch(/INVENTORY_SESSION_CANCELLED/);
    expect(closeInventory).toMatch(/INVENTORY_NO_FINAL_DISCREPANCY/);
  });
});
