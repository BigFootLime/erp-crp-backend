import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const patch = fs.readFileSync(path.resolve(process.cwd(), "db/patches/20260812_procurement_reliability_sol18.sql"), "utf8");
const preflight = fs.readFileSync(path.resolve(process.cwd(), "db/patches/support/20260812_procurement_reliability_sol18.preflight.sql"), "utf8");
const verify = fs.readFileSync(path.resolve(process.cwd(), "db/patches/support/20260812_procurement_reliability_sol18.verify.sql"), "utf8");
const rollback = fs.readFileSync(path.resolve(process.cwd(), "db/patches/support/20260812_procurement_reliability_sol18.rollback.sql"), "utf8");
const releaseGate = fs.readFileSync(path.resolve(process.cwd(), "scripts/migrations/release-gate.js"), "utf8");

describe("SOL-18 procurement migration guards", () => {
  it("creates append-only promise, policy and idempotency evidence", () => {
    expect(patch).toContain("CREATE TABLE public.procurement_promised_date_events");
    expect(patch).toContain("CREATE TABLE public.procurement_policy_versions");
    expect(patch).toContain("CREATE TABLE public.procurement_command_receipts");
    expect(patch).toContain("procurement_promises_append_only");
    expect(patch).toContain("procurement_policies_append_only");
    expect(patch).toContain("reason_code = 'SUPPLIER_ACKNOWLEDGEMENT' OR previous_date IS DISTINCT FROM promised_date");
  });

  it("keeps the command receipt ledger least-privilege", () => {
    expect(patch).toContain("REVOKE ALL ON TABLE public.procurement_command_receipts FROM PUBLIC, cerp_app");
    expect(patch).toContain("GRANT SELECT, INSERT ON TABLE public.procurement_command_receipts TO cerp_app");
    expect(patch).not.toMatch(/GRANT\s+[^;]*(?:UPDATE|DELETE)[^;]*ON TABLE public\.procurement_command_receipts/i);
  });

  it("does not fabricate historical promises, invoices, returns or credits", () => {
    expect(patch).not.toMatch(/INSERT\s+INTO\s+public\.procurement_promised_date_events\s+SELECT/i);
    expect(patch).not.toMatch(/supplier_invoice|facture_fournisseur|supplier_return/i);
  });

  it("ships explicit preflight, verification and guarded rollback", () => {
    expect(preflight).toContain("orders_present");
    expect(preflight).toContain("verified pg_dump backup");
    expect(verify).toContain("promise_history_valid");
    expect(verify).toContain("policy_versions_unique");
    expect(rollback).toContain("rollback refused");
    expect(rollback).toContain("restore the pre-migration backup into a fresh database");
    expect(releaseGate).toContain('const PROCUREMENT_RELIABILITY_PATCH = "20260812_procurement_reliability_sol18.sql"');
    expect(releaseGate).toContain("procurement_reliability_removed");
  });
});
