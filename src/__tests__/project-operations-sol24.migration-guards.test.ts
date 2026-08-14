import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const patch = fs.readFileSync(path.join(root, "db/patches/20260814_project_operations_sol24.sql"), "utf8");
const preflight = fs.readFileSync(path.join(root, "db/patches/support/20260814_project_operations_sol24.preflight.sql"), "utf8");
const verify = fs.readFileSync(path.join(root, "db/patches/support/20260814_project_operations_sol24.verify.sql"), "utf8");
const rollback = fs.readFileSync(path.join(root, "db/patches/support/20260814_project_operations_sol24.rollback.sql"), "utf8");
const runner = fs.readFileSync(path.join(root, "scripts/db-patches.js"), "utf8");
const releaseGate = fs.readFileSync(path.join(root, "scripts/migrations/release-gate.js"), "utf8");

describe("SOL-24 migration guards", () => {
  it("reste additive, transactionnelle et rejouable", () => {
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.project_budget_versions");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.hr_period_closures");
    expect(patch).toContain("ADD COLUMN IF NOT EXISTS rate_version_id");
    expect(patch).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|TYPE)\b/i);
    expect(patch).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("dispose d'un preflight, d'une vérification et d'un rollback test-only", () => {
    expect(preflight).toContain("Prerequis SOL-24 manquants");
    expect(verify).toContain("Objets SOL-24 manquants");
    expect(verify).toContain("orphan_project_affaire_links");
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("Rollback refuse: donnees SOL-24 presentes");
    expect(runner).toContain('"20260814_project_operations_sol24.sql":');
    expect(runner).toContain("e978abeb2b6758744d3824540b2552ef6b6ca90f0c634bc49dd7af403d4e8cd9");
    expect(releaseGate).toContain('const PROJECT_OPERATIONS_PATCH = "20260814_project_operations_sol24.sql"');
    expect(releaseGate).toContain("project_operations_removed");
  });
});
