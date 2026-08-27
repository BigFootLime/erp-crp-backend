import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const filename = "20260827_supplier_invoices_675.sql";
const patch = fs.readFileSync(path.join(root, "db/patches", filename), "utf8");
const preflight = fs.readFileSync(path.join(root, "db/patches/support/20260827_supplier_invoices_675.preflight.sql"), "utf8");
const verify = fs.readFileSync(path.join(root, "db/patches/support/20260827_supplier_invoices_675.verify.sql"), "utf8");
const rollback = fs.readFileSync(path.join(root, "db/patches/support/20260827_supplier_invoices_675.rollback.sql"), "utf8");
const runner = fs.readFileSync(path.join(root, "scripts/db-patches.js"), "utf8");
const sha256 = crypto.createHash("sha256").update(patch.replace(/\r\n?/g, "\n")).digest("hex");

describe("SUPPLIER-INVOICES-675 migration guards", () => {
  it("pins the exact additive migration in the immutable production runner", () => {
    expect(sha256).toBe("4e3f6747bab9a649d6dd93a0c62c6314c098254249319f65375aeedd2a58c8d1");
    expect(runner).toContain(`"${filename}"`);
    expect(runner).toContain(sha256);
  });

  it("keeps source documents and business evidence append-only", () => {
    expect(patch).toContain("supplier_invoice_lines_append_only_675");
    expect(patch).toContain("supplier_invoice_match_versions_append_only_675");
    expect(patch).toContain("supplier_invoice_line_matches_append_only_675");
    expect(patch).toContain("supplier_invoice_decisions_append_only_675");
    expect(patch).toContain("supplier_invoice_receipts_append_only_675");
    expect(patch).toContain("einvoice_document_id uuid NOT NULL UNIQUE");
    expect(patch).toContain("supplier_invoices_supplier_legal_675_uq");
    expect(patch).toContain("content_sha256 char(64) NOT NULL");
  });

  it("ships guarded preflight, verification and isolated rollback scripts", () => {
    expect(preflight).toContain("SUPPLIER-INVOICES-675 missing prerequisites");
    expect(verify).toContain("append-only triggers are incomplete");
    expect(rollback).toContain("allowed only on an isolated/test database");
    expect(rollback).toContain("rollback refused because supplier invoice evidence exists");
  });
});
