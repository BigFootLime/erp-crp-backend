import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const filename = "20260827_accounting_export_supplier_677.sql";
const patch = fs.readFileSync(path.join(root, "db/patches", filename), "utf8");
const preflight = fs.readFileSync(path.join(root, "db/patches/support/20260827_accounting_export_supplier_677.preflight.sql"), "utf8");
const verify = fs.readFileSync(path.join(root, "db/patches/support/20260827_accounting_export_supplier_677.verify.sql"), "utf8");
const rollback = fs.readFileSync(path.join(root, "db/patches/support/20260827_accounting_export_supplier_677.rollback.sql"), "utf8");
const runner = fs.readFileSync(path.join(root, "scripts/db-patches.js"), "utf8");
const sha256 = crypto.createHash("sha256").update(patch.replace(/\r\n?/g, "\n")).digest("hex");

describe("ACCOUNTING-EXPORT-677 migration guards", () => {
  it("pins the exact additive migration in the immutable production runner", () => {
    expect(sha256).toBe("de1bd03efb37635d655c2536a35fe6c99d7be0b447b3bdbd5ed3727d9d77c94f");
    expect(runner).toContain(`"${filename}"`);
    expect(runner).toContain(sha256);
  });

  it("extends every immutable SOL-27 source registry", () => {
    expect(patch.match(/SUPPLIER_INVOICE/g)?.length).toBeGreaterThanOrEqual(4);
    expect(patch.match(/SUPPLIER_CREDIT_NOTE/g)?.length).toBeGreaterThanOrEqual(4);
    expect(patch).toContain("cardinality(source_types) BETWEEN 1 AND 5");
  });

  it("ships guarded preflight, verification and isolated rollback scripts", () => {
    expect(preflight).toContain("ACCOUNTING-EXPORT-677 missing prerequisites");
    expect(verify).toContain("source constraints are incomplete");
    expect(rollback).toContain("allowed only on an isolated/test database");
    expect(rollback).toContain("rollback refused because supplier accounting evidence exists");
  });
});
