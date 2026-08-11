import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/repo-paths";

const migration = readFileSync(
  resolve(repoRoot, "db/patches/20260731_stock_old_new_446.sql"),
  "utf8"
);
const preflight = readFileSync(
  resolve(repoRoot, "db/patches/support/20260731_stock_old_new_446.preflight.sql"),
  "utf8"
);
const verify = readFileSync(
  resolve(repoRoot, "db/patches/support/20260731_stock_old_new_446.verify.sql"),
  "utf8"
);
const rollback = readFileSync(
  resolve(repoRoot, "db/patches/support/20260731_stock_old_new_446.rollback.sql"),
  "utf8"
);
const navigationPatch = readFileSync(
  resolve(repoRoot, "db/patches/20260810_stock_old_new_navigation_446.sql"),
  "utf8"
);
const navigationPreflight = readFileSync(
  resolve(repoRoot, "db/patches/support/20260810_stock_old_new_navigation_446.preflight.sql"),
  "utf8"
);
const navigationVerify = readFileSync(
  resolve(repoRoot, "db/patches/support/20260810_stock_old_new_navigation_446.verify.sql"),
  "utf8"
);
const navigationRollback = readFileSync(
  resolve(repoRoot, "db/patches/support/20260810_stock_old_new_navigation_446.rollback.sql"),
  "utf8"
);
const stockRepository = readFileSync(
  resolve(repoRoot, "src/module/stock/repository/stock.repository.ts"),
  "utf8"
);

describe("#446 stock OLD/NEW migration guards", () => {
  it("reste additive, transactionnelle et idempotente", () => {
    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("COMMIT;");
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS stock_scope/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.stock_lot_trace_references/i);
    expect(migration).toMatch(/CREATE SEQUENCE IF NOT EXISTS public\.stock_trace_code_446_seq/i);
    expect(migration).toMatch(/ON CONFLICT \(code\) DO UPDATE/i);
    expect(migration).not.toMatch(/\b(DROP|TRUNCATE)\b/i);
  });

  it("refuse un schema magasin incompatible avant toute creation OLD/NEW", () => {
    expect(migration).toMatch(/magasins\.id\/emplacements\.magasin_id/i);
    expect(migration).toMatch(/magasin_id_type <> 'uuid'/i);
    expect(migration).toMatch(/emplacement_magasin_id_type <> 'uuid'/i);
    expect(migration).toMatch(/RAISE EXCEPTION/i);
  });

  it("cree exactement les quatre bases fonctionnelles OLD et NEW", () => {
    for (const code of ["OLD-PF", "OLD-MP", "NEW-PF", "NEW-MP"]) {
      expect(migration).toContain(`'${code}'`);
    }
    expect(migration.match(/\('(?:OLD|NEW)-(?:PF|MP)'/g)).toHaveLength(8);
    expect(migration).toMatch(/CHECK \(stock_scope IN \('OLD', 'NEW'\)\)/i);
    expect(migration).toMatch(/code_magasin, name, libelle, stock_scope, warehouse_id, is_active, actif/i);
    expect(migration).toMatch(/seed\.code, seed\.code, seed\.name, seed\.name/i);
    expect(migration).toMatch(/actif = true/i);
  });

  it("verrouille la trace a six chiffres et son QR associe", () => {
    expect(migration).toMatch(/\^\[0-9\]\{6\}\$/);
    expect(migration).toContain("qr_payload = 'CERP-STOCK:' || stock_trace_code::text");
    expect(migration).toMatch(/origin_stock_scope IN \('OLD', 'NEW'\)/i);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS lots_stock_trace_code_446_uq/i);
  });

  it("accorde au runtime les droits minimaux sur les nouveaux objets", () => {
    expect(migration).toMatch(
      /GRANT SELECT, INSERT ON public\.stock_lot_trace_references TO cerp_app/i
    );
    expect(migration).toMatch(
      /GRANT USAGE, SELECT ON SEQUENCE public\.stock_trace_code_446_seq TO cerp_app/i
    );
  });

  it("conserve le code technique et ne change que le libelle Fourniture Client", () => {
    expect(migration).toContain("SET label = 'Fourniture Client'");
    expect(migration).toContain("WHERE code = 'achat_transforme'");
  });

  it("fournit un preflight strictement en lecture seule avant application", () => {
    expect(preflight).toMatch(/BEGIN TRANSACTION READ ONLY;/i);
    expect(preflight).toMatch(/COMMIT;/i);
    expect(preflight).toMatch(/UUID magasins\.id\/emplacements\.magasin_id/i);
    expect(preflight).toMatch(/magasins\.code_magasin\/libelle varchar and magasins\.actif boolean/i);
    expect(preflight).toMatch(/article_category_ref/i);
    expect(preflight).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
  });

  it("verifie en lecture seule les structures, les quatre bases et les grants runtime", () => {
    expect(verify).toMatch(/BEGIN TRANSACTION READ ONLY;/i);
    expect(verify).toMatch(/stock_lot_trace_references/i);
    expect(verify).toMatch(/stock_trace_code_446_seq/i);
    expect(verify).toMatch(/v_fixed_store_count <> 4/i);
    expect(verify).toMatch(/magasin\.code_magasin = expected\.code/i);
    expect(verify).toMatch(/magasin\.actif/i);
    expect(verify).toMatch(/has_table_privilege\('cerp_app'/i);
    expect(verify).toMatch(/has_sequence_privilege\('cerp_app'/i);
    expect(verify).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
  });

  it("limite le rollback a cerp_test et refuse toute preuve metier #446", () => {
    expect(rollback).toMatch(/current_database\(\) <> 'cerp_test'/i);
    expect(rollback).toMatch(/stock_lot_trace_references/i);
    expect(rollback).toMatch(/stock_trace_code IS NOT NULL/i);
    expect(rollback).toMatch(/stock_movement_lines/i);
    expect(rollback).toMatch(/rollback refused/i);
    expect(rollback).toMatch(/OR code_magasin IN/i);
    expect(rollback).toMatch(/DROP TABLE IF EXISTS public\.stock_lot_trace_references/i);
  });
});

describe("#446 Base OLD corrective guards", () => {
  it("creates a historical PF with the canonical technical-piece status", () => {
    const historicalPieceStart = stockRepository.indexOf("async function ensureHistoricalPieceTechniqueTx");
    const historicalPieceEnd = stockRepository.indexOf("export async function repoCreateHistoricalImport");
    const historicalPieceSource = stockRepository.slice(historicalPieceStart, historicalPieceEnd);

    expect(historicalPieceStart).toBeGreaterThanOrEqual(0);
    expect(historicalPieceEnd).toBeGreaterThan(historicalPieceStart);
    expect(historicalPieceSource).toContain("'DRAFT'");
    expect(historicalPieceSource).not.toContain("'EN_DEVIS'");
  });

  it("keeps OLD imports independent from orders, affairs and fabrication orders", () => {
    const historicalImportStart = stockRepository.indexOf("export async function repoCreateHistoricalImport");
    const historicalImportEnd = stockRepository.indexOf("export async function repoListBalances");
    const historicalImportSource = stockRepository.slice(historicalImportStart, historicalImportEnd);

    expect(historicalImportSource).toContain("CERP_HISTORICAL_OPENING");
    expect(historicalImportSource).toContain("stock_lot_trace_references");
    expect(historicalImportSource).not.toMatch(/\b(?:affaire_id|of_id|commande_id)\b/);
  });

  it("resolves an existing MP nuance through the canonical stock referential", () => {
    const historicalImportStart = stockRepository.indexOf("export async function repoCreateHistoricalImport");
    const historicalImportEnd = stockRepository.indexOf("export async function repoListBalances");
    const historicalImportSource = stockRepository.slice(historicalImportStart, historicalImportEnd);

    expect(historicalImportSource).toContain("public.stock_nuances");
    expect(historicalImportSource).not.toContain("public.matiere_nuances");
  });

  it("creates a historical PF without depending on the obsolete central family catalog", () => {
    const historicalImportStart = stockRepository.indexOf("export async function repoCreateHistoricalImport");
    const historicalImportEnd = stockRepository.indexOf("export async function repoListBalances");
    const historicalImportSource = stockRepository.slice(historicalImportStart, historicalImportEnd);

    expect(historicalImportSource).toContain('defaultFamilyCodeForCategory("fabrique")');
    expect(historicalImportSource).not.toContain("public.article_families");
  });

  it("adds the OLD and NEW navigation shortcuts without replacing existing keys", () => {
    expect(navigationPatch).toContain("BEGIN;");
    expect(navigationPatch).toContain("COMMIT;");
    expect(navigationPatch).toContain("'stock-base-old'");
    expect(navigationPatch).toContain("'stock-base-new'");
    expect(navigationPatch).toContain("COALESCE(nav_page_keys");
    expect(navigationPatch).toContain("|| CASE");
    expect(navigationPatch).not.toMatch(/\b(DROP|TRUNCATE|DELETE)\b/i);
  });

  it("keeps navigation preflight and verification read-only", () => {
    for (const script of [navigationPreflight, navigationVerify]) {
      expect(script).toMatch(/BEGIN TRANSACTION READ ONLY;/i);
      expect(script).toMatch(/COMMIT;/i);
      expect(script).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
    }
  });

  it("limits the navigation rollback to cerp_test and only removes the two shortcuts", () => {
    expect(navigationRollback).toMatch(/current_database\(\) <> 'cerp_test'/i);
    expect(navigationRollback).toContain("array_remove");
    expect(navigationRollback).toContain("'stock-base-old'");
    expect(navigationRollback).toContain("'stock-base-new'");
    expect(navigationRollback).not.toMatch(/\b(DROP|TRUNCATE|DELETE)\b/i);
  });
});
