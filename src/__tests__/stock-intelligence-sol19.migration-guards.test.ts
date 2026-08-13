import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => fs.readFileSync(path.resolve(process.cwd(), name), "utf8");
const patch = read("db/patches/20260813_stock_intelligence_sol19.sql");
const preflight = read("db/patches/support/20260813_stock_intelligence_sol19.preflight.sql");
const verify = read("db/patches/support/20260813_stock_intelligence_sol19.verify.sql");
const rollback = read("db/patches/support/20260813_stock_intelligence_sol19.rollback.sql");
const releaseGate = read("scripts/migrations/release-gate.js");

describe("SOL-19 stock intelligence migration guards", () => {
  it("versions decision parameters and protects policy evidence", () => {
    expect(patch).toContain("CREATE TABLE public.stock_intelligence_policy_versions");
    expect(patch).toContain("CREATE TABLE public.stock_intelligence_command_receipts");
    expect(patch).toContain("abc_a_cumulative_pct < abc_b_cumulative_pct");
    expect(patch).toContain("stock_intelligence_policies_append_only");
    expect(patch).not.toMatch(/INSERT\s+INTO\s+public\.stock_intelligence_policy_versions/i);
  });

  it("ships preflight, verification and a guarded evidence-preserving rollback", () => {
    expect(preflight).toContain("authoritative_availability_present");
    expect(preflight).toContain("verified pg_dump backup");
    expect(verify).toContain("policy_values_valid");
    expect(verify).toContain("receipt_hashes_valid");
    expect(rollback).toContain("rollback refused");
    expect(rollback).toContain("restore the pre-migration backup into a fresh database");
  });

  it("is included in the isolated migration and rollback gate", () => {
    expect(releaseGate).toContain('const STOCK_INTELLIGENCE_PATCH = "20260813_stock_intelligence_sol19.sql"');
    expect(releaseGate).toContain("stock_intelligence_removed");
  });
});
