import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const patch = readFileSync(
  resolve(root, "db/patches/20260723_stock_traceability_225.sql"),
  "utf8"
);
const preflight = readFileSync(
  resolve(root, "db/patches/support/20260723_stock_traceability_225.preflight.sql"),
  "utf8"
);
const verify = readFileSync(
  resolve(root, "db/patches/support/20260723_stock_traceability_225.verify.sql"),
  "utf8"
);
const rollback = readFileSync(
  resolve(root, "db/patches/support/20260723_stock_traceability_225.rollback.sql"),
  "utf8"
);

describe("#225 migration guards", () => {
  it("keeps the forward patch additive and transactional", () => {
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
    expect(patch).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(patch).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("protects posted movements and append-only evidence", () => {
    expect(patch).toContain("trg_protect_posted_stock_movement");
    expect(patch).toContain("trg_protect_posted_stock_movement_line");
    expect(patch).toContain("trg_protect_stock_command_receipt");
    expect(patch).toContain("trg_protect_stock_inventory_count");
    expect(patch).toContain("stock audit evidence is immutable");
  });

  it("separates draft creation time from inventory start time", () => {
    expect(patch).toContain("ALTER COLUMN started_at DROP NOT NULL");
    expect(patch).toContain("ALTER COLUMN started_at DROP DEFAULT");
    expect(patch).not.toContain(
      "CONSTRAINT stock_inventory_snapshot_qty_ck CHECK (theoretical_qty >= 0)"
    );
    expect(verify).toContain("draft_sessions_started_too_early");
    expect(verify).toContain("active_sessions_without_start");
  });

  it("keeps quality-aware availability explicit", () => {
    expect(patch).toContain("CREATE OR REPLACE VIEW public.v_stock_availability_225");
    expect(patch).toContain("qty_quarantine");
    expect(patch).toContain("qty_blocked");
    expect(patch).toContain("qty_available");
    expect(patch).toContain("row.lot_status IS NULL OR row.lot_status = 'LIBERE'");
  });

  it("restricts support scripts and refuses a lossy rollback", () => {
    for (const script of [preflight, verify, rollback]) {
      expect(script).toContain("current_database() <> 'cerp_test'");
    }
    expect(preflight).toContain("required stock columns");
    expect(preflight).toContain(
      "table_name = 'stock_movement_event_log' AND column_name IN ('id', 'stock_movement_id', 'event_type')"
    );
    expect(preflight).not.toContain(
      "table_name = 'stock_movement_event_log' AND column_name IN ('id', 'movement_id', 'event_type')"
    );
    expect(rollback).toContain(
      "#225 rollback refused: immutable stock evidence exists"
    );
    expect(rollback).toContain("DROP COLUMN IF EXISTS reversal_of_id");
    expect(rollback).toContain("ALTER COLUMN started_at SET NOT NULL");
  });
});
