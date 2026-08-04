import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/repo-paths";

const patch = fs.readFileSync(path.join(repoRoot, "db", "patches", "20260805_margin_engine_0001.sql"), "utf8");
const support = path.join(repoRoot, "db", "patches", "support");
const repository = fs.readFileSync(path.join(repoRoot, "src", "module", "margin-engine", "repository", "margin-engine.repository.ts"), "utf8");

describe("margin engine migration guards", () => {
  it("is additive and does not rewrite existing business history", () => {
    expect(patch).not.toMatch(/\bTRUNCATE\b/i);
    expect(patch).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(patch).not.toMatch(/\bUPDATE\s+(public\.)?(devis|affaire|ordres_fabrication|of_operations)\b/i);
    expect(patch).not.toMatch(/DROP\s+TABLE/i);
  });

  it("protects rates, inputs and recalculation proofs as append-only", () => {
    expect(patch).toContain("trg_margin_rate_versions_append_only");
    expect(patch).toContain("trg_margin_rates_append_only");
    expect(patch).toContain("trg_margin_input_versions_append_only");
    expect(patch).toContain("trg_margin_recalculations_append_only");
    expect(patch).toContain("rate_effective_at date");
    expect(patch).toContain("rate_validation_snapshot jsonb");
  });

  it("ships preflight, verification, cerp_test demo and rollback scripts", () => {
    for (const suffix of ["preflight.sql", "verify.sql", "cerp_test_demo.sql", "rollback.sql"]) {
      expect(fs.existsSync(path.join(support, `20260805_margin_engine_0001.${suffix}`))).toBe(true);
    }
    const demo = fs.readFileSync(path.join(support, "20260805_margin_engine_0001.cerp_test_demo.sql"), "utf8");
    expect(demo).toContain("current_database() <> 'cerp_test'");
  });

  it("does not multiply an already calculated technical operation cost by quote quantity", () => {
    expect(repository).not.toMatch(/op\.cout_mo\s*\*\s*dl\.quantite/i);
    expect(repository).toContain("round(op.cout_mo, 6)::text AS amount_ht");
  });
});
