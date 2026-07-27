import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const patch = readFileSync(
  resolve(root, "db/patches/20260727_stock_import_precision_198.sql"),
  "utf8"
);
const preflight = readFileSync(
  resolve(root, "db/patches/support/20260727_stock_import_precision_198.preflight.sql"),
  "utf8"
);
const verify = readFileSync(
  resolve(root, "db/patches/support/20260727_stock_import_precision_198.verify.sql"),
  "utf8"
);
const rollback = readFileSync(
  resolve(root, "db/patches/support/20260727_stock_import_precision_198.rollback.sql"),
  "utf8"
);

describe("stock opening precision migration #198", () => {
  it("widens movement lines to the six-decimal stock ledger precision", () => {
    expect(patch).toContain("ALTER COLUMN qty TYPE numeric(18,6)");
    expect(patch).toContain("source_document_type = 'CLIPPER_STOCK_OPENING'");
    expect(patch).toContain("abs(opening_lines.old_line_qty - opening_lines.posted_qty) < 0.0005");
  });

  it("keeps the posted-line repair bounded, transactional and auditable", () => {
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("current_database() <> 'cerp_test'");
    expect(patch).toContain("DISABLE TRIGGER trg_protect_posted_stock_movement_line");
    expect(patch).toContain("ENABLE TRIGGER trg_protect_posted_stock_movement_line");
    expect(patch).toContain("PRECISION_RECONCILED_198");
    expect(patch).toContain("COMMIT;");
  });

  it("blocks unsafe data and verifies line, header and level reconciliation", () => {
    expect(preflight).toContain("abs(line_qty - posted_qty) >= 0.0005");
    expect(preflight).toContain("lines_count <> 1");
    expect(verify).toContain("opening_lines_match_posted_headers");
    expect(verify).toContain("opening_headers_match_stock_levels");
  });

  it("provides a conservative test-only rollback", () => {
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("PRECISION_ROLLBACK_198");
    expect(rollback).toContain("ALTER COLUMN qty TYPE numeric(18,3)");
    expect(rollback).toContain("six-decimal quantities exist outside the audited repair set");
  });
});
