import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/repo-paths";

const patchName = "20260811_margin_traceability_0002";
const patch = fs.readFileSync(path.join(repoRoot, "db", "patches", `${patchName}.sql`), "utf8");
const repository = fs.readFileSync(path.join(repoRoot, "src", "module", "margin-engine", "repository", "margin-engine.repository.ts"), "utf8");
const support = path.join(repoRoot, "db", "patches", "support");
const releaseGate = fs.readFileSync(path.join(repoRoot, "scripts", "migrations", "release-gate.js"), "utf8");

describe("SOL-13 margin traceability migration guards", () => {
  it("only changes governed margin metadata and constraints", () => {
    expect(patch).toContain("SET LOCAL lock_timeout = '5s'");
    expect(patch).not.toMatch(/\bTRUNCATE\b/i);
    expect(patch).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(patch).not.toMatch(/\bUPDATE\s+(?:public\.)?(?:devis|affaire|ordres_fabrication|stock_movements)\b/i);
    expect(patch).not.toMatch(/DROP\s+TABLE/i);
  });

  it("keeps legacy PLANNED evidence readable while governing four explicit perspectives", () => {
    for (const basis of ["QUOTED", "STANDARD", "UPDATED", "ACTUAL"]) expect(patch).toContain(`'${basis}'`);
    expect(patch).toContain("'PLANNED'");
    expect(patch).toContain("evidence_contract_version");
    expect(patch).toContain("source_reliability");
    expect(patch).toMatch(/source_reliability <> 'VERIFIED'[\s\S]*source_document_type[\s\S]*source_document_ref/);
    expect(patch).toContain("'REWORK'");
  });

  it("ships preflight, post-validation and a guarded non-production rollback", () => {
    for (const suffix of ["preflight.sql", "verify.sql", "rollback.sql"]) {
      expect(fs.existsSync(path.join(support, `${patchName}.${suffix}`))).toBe(true);
    }
    const preflight = fs.readFileSync(path.join(support, `${patchName}.preflight.sql`), "utf8");
    const verify = fs.readFileSync(path.join(support, `${patchName}.verify.sql`), "utf8");
    const rollback = fs.readFileSync(path.join(support, `${patchName}.rollback.sql`), "utf8");
    expect(preflight).toContain("BEGIN TRANSACTION READ ONLY");
    expect(verify).toContain("BEGIN TRANSACTION READ ONLY");
    expect(rollback).toContain("restricted to cerp_dev/cerp_test");
    expect(rollback).toContain("restore the pre-migration backup in production");
    expect(preflight).toContain("bc0706c2af406d9a8e9f8221beb05492f9f0f7eba879de26cb77c8542863f514");
    expect(verify).toContain("8639afd24dfbf6ecd49131d2247c506ec1ca7acc17346bfdbacb61aaf6582d61");
    expect(rollback).toContain("pg_advisory_xact_lock(hashtext('cerp_schema_migrations'))");
    expect(rollback).toContain("DELETE FROM public.cerp_schema_migrations");
    expect(releaseGate).toContain('const MARGIN_TRACEABILITY_PATCH = "20260811_margin_traceability_0002.sql"');
    expect(releaseGate).toContain("margin_traceability_removed");
    expect(rollback).not.toMatch(/\bCASCADE\b/i);
  });

  it("uses canonical actual stock, supplier receipt and declaration evidence", () => {
    expect(repository).toContain("STOCK_CUMP_CONSUMPTION");
    expect(repository).toContain("reservation.status::text = 'CONSUMED'");
    expect(repository).toContain("SUPPLIER_RECEPTION_ACTUAL");
    expect(repository).toContain("PRODUCTION_QUANTITY_DECLARATIONS");
    expect(repository).not.toMatch(/COALESCE\(\(SELECT sum\(qty_(?:good|scrap|rework)/i);
  });

  it("never substitutes actual OF hours for a missing quoted cost", () => {
    expect(repository).toContain('identity.scope_type === "OF" && basis !== "QUOTED"');
    expect(repository).not.toMatch(/identity\.scope_type === "OF"\)\s*\{\s*const ofData = await loadOfCosts/);
  });
});
