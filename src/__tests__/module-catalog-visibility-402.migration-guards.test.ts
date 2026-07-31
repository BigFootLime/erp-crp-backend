import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const patch = readFileSync(
  resolve(root, "db/patches/20260730_repair_module_catalog_visibility_402.sql"),
  "utf8"
);
const preflight = readFileSync(
  resolve(root, "db/patches/support/20260730_repair_module_catalog_visibility_402.preflight.sql"),
  "utf8"
);
const verify = readFileSync(
  resolve(root, "db/patches/support/20260730_repair_module_catalog_visibility_402.verify.sql"),
  "utf8"
);

describe("#402 catalogue de visibilité des modules", () => {
  it("est transactionnel et ne réécrit ni les choix d'exploitation ni les overrides", () => {
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
    expect(patch).not.toMatch(/\benabled_by_default\s*=/i);
    expect(patch).not.toMatch(/\bis_active\s*=/i);
    expect(patch).toMatch(/\bINSERT\s+INTO\s+public\.app_module_user_access/i);
    expect(patch).toContain("ON CONFLICT (user_id, module_key) DO NOTHING");
    expect(patch).not.toMatch(/\bUPDATE\s+public\.app_module_user_access/i);
    expect(patch).not.toMatch(/\bDELETE\s+FROM\s+public\.app_module_user_access/i);
  });

  it("corrige le vrai catalogue app_modules, sans revenir aux anciennes migrations access_modules", () => {
    expect(patch).toContain("public.app_modules");
    expect(patch).not.toContain("public.access_modules");
    expect(patch).toContain("'/finitions'");
    expect(patch).toContain("'methodes-centres-frais'");
    expect(patch).toContain("'methodes-parc-machines'");
  });

  it("déclare une GED autonome, non protégée, sans modifier Project Office", () => {
    expect(patch).toContain("'ged'");
    expect(patch).toContain("ARRAY['/ged']");
    expect(patch).toContain("is_protected = false");
    expect(patch).toContain("Project Office");
    expect(patch).not.toMatch(/PROJECT_OFFICE\s*=/);
  });

  it("fournit un préflight et un verify non destructifs, bornés aux bases CERP", () => {
    for (const script of [preflight, verify]) {
      expect(script).toContain("\\set ON_ERROR_STOP on");
      expect(script).toContain("current_database() NOT IN ('cerp_test', 'cerp_prod')");
      expect(script).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(script).not.toMatch(/\bUPDATE\s+public\./i);
      expect(script).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(script).not.toMatch(/\bDROP\s+/i);
    }
    expect(preflight).toContain("technical_module_count <> 1");
    expect(preflight).toContain("module_key = 'pieces-techniques'");
  });
});
