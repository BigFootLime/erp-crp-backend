import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const migrationName = "20260815_historical_test_guard_convergence_sol43";
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");
const migration = read(`db/patches/${migrationName}.sql`);
const preflight = read(`db/patches/support/${migrationName}.preflight.sql`);
const verify = read(`db/patches/support/${migrationName}.verify.sql`);
const rollback = read(`db/patches/support/${migrationName}.rollback.sql`);
const runner = read("scripts/db-patches.js");

const legacy = new Map([
  ["20260727_contacts_email_scope_187.sql", "4d43141bc2e6b803f4b37d1dff146c9950e64c75f0b317194ebf03dacbddbf1a"],
  ["20260727_contacts_shared_email_identity_190.sql", "b3b030cefbbf16ceca44481d74380de71803d72320c19b4da9cc62eee37aaf89"],
  ["20260727_import_supplier_orders_312.sql", "5988f518ebfe8160372ec833fb14fba636a54638f367a637703162032d7193a0"],
  ["20260727_stock_import_precision_198.sql", "0a348b7d6b723ba2d38b4927a5eed9a3999e3dfa82f56940f1f3a4d5b2da5a6a"],
]);

describe("SOL-43 historical test-guard convergence migration", () => {
  it("keeps the immutable legacy hashes and records explicit supersession provenance", () => {
    for (const [filename, sha256] of legacy) {
      expect(migration).toContain(filename);
      expect(migration).toContain(sha256);
      expect(preflight).toContain(filename);
      expect(preflight).toContain(sha256);
    }
    expect(migration).toContain("cerp_migration_supersessions");
    expect(migration).toContain("ON CONFLICT (filename) DO NOTHING");
    expect(verify).toContain("expected 4 provenance records");
  });

  it("applies only the final contact, supplier-import and stock-precision states", () => {
    expect(migration).toContain("contacts_client_email_identity_active_key");
    expect(migration).toContain("FOURNISSEUR_COMMANDE");
    expect(migration).toContain("ALTER COLUMN qty TYPE numeric(18,6)");
    expect(migration).toContain("PRECISION_RECONCILED_198");
    expect(migration).toContain("abs(opening_lines.old_line_qty - opening_lines.posted_qty) < 0.0005");
    expect(migration).toContain("DISABLE TRIGGER trg_protect_posted_stock_movement_line");
    expect(migration).toContain("ENABLE TRIGGER trg_protect_posted_stock_movement_line");
  });

  it("restricts execution, keeps preflight and verify read-only, and requires backup restore for rollback", () => {
    expect(migration).toContain("current_database() NOT IN ('cerp_test', 'cerp_prod')");
    expect(preflight).toContain("BEGIN TRANSACTION READ ONLY");
    expect(preflight).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
    expect(verify).toContain("BEGIN TRANSACTION READ ONLY");
    expect(verify).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
    expect(rollback).toContain("restoring the verified pre-migration custom-format backup");
    expect(rollback).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
  });

  it("registers the exact migration checksum for safe one-patch convergence", () => {
    const sha256 = createHash("sha256").update(migration.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
    expect(sha256).toBe("4ab8dc57c44b3baaa77314e7ef7725df28ac5afacdc66f189d1935bd4bffd828");
    expect(runner).toContain(`"${migrationName}.sql":`);
    expect(runner).toContain(sha256);
  });
});
