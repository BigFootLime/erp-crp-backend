import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const base = "20260823_authoritative_pdf_ged_entity_contract";
const patch = fs.readFileSync(path.join(root, "db/patches", `${base}.sql`), "utf8");
const preflight = fs.readFileSync(path.join(root, "db/patches/support", `${base}.preflight.sql`), "utf8");
const verify = fs.readFileSync(path.join(root, "db/patches/support", `${base}.verify.sql`), "utf8");
const rollback = fs.readFileSync(path.join(root, "db/patches/support", `${base}.rollback.sql`), "utf8");
const requiredTypes = ["BON_LIVRAISON", "DEVIS", "COMMANDE_FOURNISSEUR", "FACTURE", "AVOIR"];

describe("authoritative PDF/GED entity-contract migration", () => {
  it("adds every PDF parent missing from the historical GED registry", () => {
    for (const entityType of requiredTypes) {
      expect(patch).toContain(`'${entityType}'`);
      expect(verify).toContain(`'${entityType}'`);
    }
    expect(patch).toContain("'bon_livraison'");
    expect(patch).toContain("'commande_fournisseur'");
    expect(patch).toContain("'facture'");
    expect(patch).toContain("'avoir'");
    expect(patch).toContain("'devis'");
    expect(patch).not.toContain("ON CONFLICT");
  });

  it("ships read-only gates that require the closed GED link guard", () => {
    for (const script of [preflight, verify]) {
      expect(script).toContain("BEGIN TRANSACTION READ ONLY");
      expect(script).toContain("fn_ged_link_guard()");
      expect(script).toContain("trg_ged_link_guard");
      expect(script).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/im);
    }
    expect(preflight).toContain("PREFLIGHT_TARGET_ALREADY_EXISTS");
    expect(verify).toContain("VERIFY_ROW_MISMATCH");
    expect(verify).toContain("COUNT(*) = 5");
  });

  it("refuses rollback without ledger ownership or after links/configuration exist", () => {
    expect(rollback).toContain("20260823_authoritative_pdf_ged_entity_contract.sql");
    expect(rollback).toContain("without migration-ledger ownership");
    expect(rollback).toContain("authoritative PDF GED entity links exist");
    expect(rollback).toContain("GED class bindings reference authoritative PDF entity types");
    expect(rollback).toContain("owned GED entity-contract configuration changed");
  });
});
