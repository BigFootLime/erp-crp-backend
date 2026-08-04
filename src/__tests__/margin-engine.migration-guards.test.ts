import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/repo-paths";

const patch = fs.readFileSync(path.join(repoRoot, "db", "patches", "20260805_margin_engine_0001.sql"), "utf8");
const support = path.join(repoRoot, "db", "patches", "support");
const repository = fs.readFileSync(path.join(repoRoot, "src", "module", "margin-engine", "repository", "margin-engine.repository.ts"), "utf8");
const preflight = fs.readFileSync(path.join(support, "20260805_margin_engine_0001.preflight.sql"), "utf8");
const verify = fs.readFileSync(path.join(support, "20260805_margin_engine_0001.verify.sql"), "utf8");
const rollback = fs.readFileSync(path.join(support, "20260805_margin_engine_0001.rollback.sql"), "utf8");
const expectedSha = createHash("sha256").update(patch.replace(/\r\n?/g, "\n"), "utf8").digest("hex");

describe("margin engine migration guards", () => {
  it("is additive and does not rewrite existing business history", () => {
    expect(patch).not.toMatch(/\bTRUNCATE\b/i);
    expect(patch).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(patch).not.toMatch(/\bUPDATE\s+(public\.)?(devis|affaire|ordres_fabrication|of_operations)\b/i);
    expect(patch).not.toMatch(/DROP\s+TABLE/i);
    expect(patch).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    expect(patch).not.toMatch(/\bCREATE\s+OR\s+REPLACE\b/i);
    expect(patch).toContain("target artifact already exists without this migration ledger entry");
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

  it("blocks preflight and verification unless ledger provenance and exact artifacts match", () => {
    for (const sql of [preflight, verify]) {
      expect(sql).toContain("\\set ON_ERROR_STOP on");
      expect(sql).toContain("BEGIN TRANSACTION READ ONLY");
      expect(sql).toContain(expectedSha);
      expect(sql).toContain("public.cerp_schema_migrations");
      expect(sql).toContain("RAISE EXCEPTION");
    }
    expect(verify).toContain("all target tables must be owned by cerp_app");
    expect(verify).toContain("total_constraint_count <> 44");
    expect(verify).toContain("total_index_count <> 13");
    expect(verify).toContain("total_trigger_count <> 4");
  });

  it("guards exact rollback to empty dev/test artifacts and removes the ledger row", () => {
    expect(rollback).toContain("current_database() NOT IN ('cerp_dev', 'cerp_test')");
    expect(rollback).toContain("SELECT pg_advisory_xact_lock(hashtext('cerp_schema_migrations'))");
    expect(rollback).toContain(expectedSha);
    expect(rollback).toContain("governed margin evidence exists; export/retention decision required");
    expect(rollback).toContain("DELETE FROM public.cerp_schema_migrations");
    expect(rollback).not.toMatch(/\bDROP\s+(?:TABLE|FUNCTION|TRIGGER)\s+IF\s+EXISTS\b/i);
    expect(rollback).not.toMatch(/\bCASCADE\b/i);
  });

  it("does not multiply an already calculated technical operation cost by quote quantity", () => {
    expect(repository).not.toMatch(/op\.cout_mo\s*\*\s*dl\.quantite/i);
    expect(repository).toContain("round(op.cout_mo, 6)::text AS amount_ht");
  });
});
