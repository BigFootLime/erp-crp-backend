import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const patch = read("db/patches/20260814_adv_reliability_sol23.sql");
const preflight = read("db/patches/support/20260814_adv_reliability_sol23.preflight.sql");
const verify = read("db/patches/support/20260814_adv_reliability_sol23.verify.sql");
const rollback = read("db/patches/support/20260814_adv_reliability_sol23.rollback.sql");
const releaseGate = read("scripts/migrations/release-gate.js");

describe("SOL-23 migration safety", () => {
  it("creates structured cases, immutable evidence and idempotent receipts", () => {
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.adv_delivery_blocks");
    expect(patch).toContain("QUALITY','DOCUMENT','STOCK','TRANSPORT");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.adv_payment_promises");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.adv_invoice_disputes");
    expect(patch).toContain("trg_adv_case_events_append_only_0455");
    expect(patch).toContain("adv_command_receipts_action_key_0455_uq");
  });

  it("freezes future OTIF without rewriting historical promises", () => {
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.adv_otif_assessments");
    expect(patch).toContain("trg_adv_freeze_otif_0455");
    expect(patch).toContain("ON CONFLICT(order_id) DO NOTHING");
    expect(patch).not.toMatch(/INSERT INTO public\.adv_otif_assessments[\s\S]{0,800}FROM public\.commande_client/i);
  });

  it("provides preflight, verification and isolated guarded rollback", () => {
    expect(preflight).toContain("PostgreSQL 14+ requis");
    expect(verify).toContain("Tables SOL-23 absentes");
    expect(rollback).toContain("cerp.migration_rehearsal");
    expect(rollback).toContain("Rollback refuse: historique ADV present");
    expect(releaseGate).toContain('const ADV_RELIABILITY_PATCH = "20260814_adv_reliability_sol23.sql"');
  });
});
