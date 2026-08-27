import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const base = "20260823_authoritative_pdf_ged_entity_contract";
const patch = fs.readFileSync(path.join(root, "db/patches", `${base}.sql`), "utf8");
const preflight = fs.readFileSync(path.join(root, "db/patches/support", `${base}.preflight.sql`), "utf8");
const verify = fs.readFileSync(path.join(root, "db/patches/support", `${base}.verify.sql`), "utf8");
const rollback = fs.readFileSync(path.join(root, "db/patches/support", `${base}.rollback.sql`), "utf8");
const bridgeBase = "20260823_authoritative_pdf_ged_compatibility_bridge";
const cleanupBase = "20260823_authoritative_pdf_ged_legacy_profile_cleanup";
const bridge = fs.readFileSync(path.join(root, "db/patches", `${bridgeBase}.sql`), "utf8");
const bridgePreflight = fs.readFileSync(path.join(root, "db/patches/support", `${bridgeBase}.preflight.sql`), "utf8");
const bridgeVerify = fs.readFileSync(path.join(root, "db/patches/support", `${bridgeBase}.verify.sql`), "utf8");
const bridgeRollback = fs.readFileSync(path.join(root, "db/patches/support", `${bridgeBase}.rollback.sql`), "utf8");
const cleanup = fs.readFileSync(path.join(root, "db/patches", `${cleanupBase}.sql`), "utf8");
const cleanupPreflight = fs.readFileSync(path.join(root, "db/patches/support", `${cleanupBase}.preflight.sql`), "utf8");
const cleanupVerify = fs.readFileSync(path.join(root, "db/patches/support", `${cleanupBase}.verify.sql`), "utf8");
const cleanupRollback = fs.readFileSync(path.join(root, "db/patches/support", `${cleanupBase}.rollback.sql`), "utf8");
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

  it("bridges the legacy SOL-20 profile only for the immutable contract window", () => {
    expect(bridgeBase.localeCompare(base)).toBeLessThan(0);
    expect(cleanupBase.localeCompare(base)).toBeGreaterThan(0);
    expect(bridge).toContain("fn_ged_validate_canonical_entity_link_20()");
    expect(bridge).toContain("cerp_authoritative_pdf_ged_bridge_20260823");
    expect(bridge).toContain("LEGACY_LINKS_NOT_EMPTY");
    expect(cleanup).toContain("20260823_authoritative_pdf_ged_entity_contract.sql");
    expect(cleanup).toContain("DROP TABLE public.ged_entity_types");
    expect(cleanup).toContain("DROP TABLE public.cerp_authoritative_pdf_ged_bridge_20260823");

    for (const script of [bridgePreflight, bridgeVerify, cleanupPreflight, cleanupVerify]) {
      expect(script).toContain("BEGIN TRANSACTION READ ONLY");
      expect(script).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/im);
    }
    expect(cleanupVerify).toContain("LEGACY_SOL20");
    expect(cleanupVerify).toContain("CLOSED_REGISTRY");
    expect(verify).toContain("20260823_authoritative_pdf_ged_legacy_profile_cleanup.sql");
    expect(verify).toContain("AUTHORITATIVE_PDF_GED_ENTITY_CONTRACT_VERIFY_CLEANUP_DRIFT");
    expect(bridgeVerify).toContain("20260823_authoritative_pdf_ged_legacy_profile_cleanup.sql");
    expect(bridgeVerify).toContain("trg_ged_validate_canonical_entity_link_20");
    expect(bridgeVerify).toContain("AUTHORITATIVE_PDF_GED_COMPATIBILITY_VERIFY_CLEANUP_DRIFT");
    expect(bridgeRollback).toContain("immutable entity contract has consumed");
    expect(cleanupRollback).toContain("production legacy cleanup is not automatically reversible");
  });
});
