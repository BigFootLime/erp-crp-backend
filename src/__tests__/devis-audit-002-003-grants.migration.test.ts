import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const name = "20260819_devis_preparation_idempotency_grants_002_003";
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");
const migration = read(`db/patches/${name}.sql`);
const preflight = read(`db/patches/support/${name}.preflight.sql`);
const verify = read(`db/patches/support/${name}.verify.sql`);
const rollback = read(`db/patches/support/${name}.rollback.sql`);
const runner = read("scripts/db-patches.js");
const releaseGate = read("scripts/migrations/release-gate.js");

describe("CERP-AUDIT-002/003 Devis runtime grants", () => {
  it("grants only operations proven by the quote repositories", () => {
    expect(migration).toContain("GRANT SELECT, INSERT, DELETE ON TABLE public.article_devis TO cerp_app");
    expect(migration).toContain("GRANT SELECT, INSERT, DELETE ON TABLE public.dossier_technique_piece_devis TO cerp_app");
    expect(migration).toContain("GRANT SELECT, INSERT ON TABLE public.devis_idempotence TO cerp_app");
    expect(migration).not.toMatch(/GRANT\s+(ALL|UPDATE|TRUNCATE)/i);
  });

  it("has target and role guards with read-only support scripts", () => {
    for (const relation of ["article_devis", "dossier_technique_piece_devis", "devis_idempotence"]) {
      expect(migration).toContain(relation);
      expect(preflight).toContain(relation);
      expect(verify).toContain(relation);
    }
    expect(migration).toContain("current_database() NOT IN ('cerp_test', 'cerp_prod')");
    expect(migration).toContain("runtime role cerp_app is missing");
    expect(preflight).toContain("BEGIN TRANSACTION READ ONLY");
    expect(preflight).toContain("('devis', 'conditions_paiement_id')");
    expect(preflight).toContain("('devis', 'compte_vente_id')");
    expect(preflight).toContain("('devis_ligne', 'position')");
    expect(preflight).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/im);
    expect(verify).toContain("has_table_privilege('cerp_app'");
  });

  it("uses backup restoration as the only conservative rollback", () => {
    expect(rollback).toContain("verified pre-migration backup");
    expect(rollback).toContain("Do not REVOKE in place");
    expect(rollback).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/im);
  });

  it("pins the migration and makes release preflight verify privileges after application", () => {
    const sha256 = createHash("sha256").update(migration.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
    expect(runner).toContain(`\"${name}.sql\":`);
    expect(runner).toContain(sha256);
    expect(releaseGate).toContain("DEVIS_AUDIT_GRANTS_PATCH");
    expect(releaseGate).toContain("runDevisAuditGrantReleasePreflight(client, ledger)");
    expect(releaseGate).toContain("!ledger.pending.includes(DEVIS_AUDIT_GRANTS_PATCH)");
  });
});
