import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const patch = readFileSync(resolve(root, "db/patches/20260814_sol22_quality_intelligence.sql"), "utf8");
const preflight = readFileSync(resolve(root, "db/patches/support/20260814_sol22_quality_intelligence.preflight.sql"), "utf8");
const verify = readFileSync(resolve(root, "db/patches/support/20260814_sol22_quality_intelligence.verify.sql"), "utf8");
const rollback = readFileSync(resolve(root, "db/patches/support/20260814_sol22_quality_intelligence.rollback.sql"), "utf8");

describe("SOL-22 migration safety", () => {
  it("crée des coûts immuables et des politiques SPC versionnées", () => {
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.quality_cost_entry");
    expect(patch).toContain("trg_quality_cost_entry_guard_0450");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.quality_spc_policy");
    expect(patch).toContain("trg_quality_spc_policy_guard_0450");
    expect(patch).toContain("CREATE UNIQUE INDEX IF NOT EXISTS quality_spc_policy_active_characteristic_0450_uq");
    expect(patch).toContain("only one-way retirement is allowed");
    expect(patch).toContain("quality_action_verification_guard_0450");
  });

  it("fournit preflight, vérification et rollback explicitement gardé", () => {
    expect(preflight).toContain("PostgreSQL 14+ requis");
    expect(verify).toContain("Tables SOL-22 absentes");
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("Rollback refuse: preuves de cout qualite presentes");
  });

  it("ne transforme aucune absence de coût en zéro", () => {
    expect(patch).not.toMatch(/quality_cost_entry[\s\S]{0,500}DEFAULT\s+0/i);
  });
});
