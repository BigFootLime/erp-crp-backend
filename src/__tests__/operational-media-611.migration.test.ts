import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const patch = fs.readFileSync(path.resolve("db/patches/20260823_operational_media_access_611.sql"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { scripts?: Record<string, string> };

describe("#611 operational media migration matrix", () => {
  it("binds every known producer to its real primary key and uses the canonical normalizer", () => {
    expect(patch).toContain("('clients','client','client_id','logo_path','clients')");
    expect(patch).toContain("('fournisseurs','fournisseur','id','logo','fournisseurs')");
    expect(patch).toContain("('users','user','id','profile_picture','chat')");
    expect(patch).toContain("('machines','machine','id','image_path','production')");
    expect(patch).toContain("('gestion_outils_outil','outil','id_outil','image','outillage')");
    expect(patch).toContain("('gestion_outils_outil','outil','id_outil','plan','outillage')");
    expect(patch).toContain("('gestion_outils_outil','outil','id_outil','esquisse','outillage')");
    expect(patch).toContain("('gestion_outils_famille','outil_famille','id_famille','image_path','outillage')");
    expect(patch).toContain("('gestion_outils_geometrie','outil_geometrie','id_geometrie','image_path','outillage')");
    expect(patch).toContain("('gestion_outils_fabricant','outil_fabricant','id_fabricant','logo','outillage')");
    expect(patch).toContain("public.fn_operational_media_normalize_key");
    expect(patch).toContain("chk_operational_media_canonical_key");
    expect(patch).toContain("chk_operational_media_active_integrity");
    expect(patch).toContain("application/pdf");
    expect(patch).toContain("'application/pdf'");
    expect(patch).toContain("'image/gif'");
    expect(patch).toContain("trg_operational_media_%1$s_%2$s");
    expect(patch).toContain("IF btrim(p_value) ~* '^https?://' THEN RETURN NULL; END IF;");
    expect(patch).toContain("E'\\\\'");
    expect(patch).toContain("lower(v) LIKE 'uploads/images/%'");
    expect(patch).toContain("WHERE value IN ('.', '..') OR value = ''");
    expect(patch).toContain("v ~ '[[:cntrl:]]'");
    expect(patch).toContain("^[A-Za-z][A-Za-z0-9+.-]*:");
    expect(patch).toContain("v_old_owner_id");
    expect(patch).toContain("ON CONFLICT (owner_type, owner_id, field_key) DO UPDATE");
    expect(patch).toContain("fn_operational_media_enforce_binding_mime");
    expect(patch).toContain("trg_operational_media_asset_mime_binding_policy");
    expect(patch).toContain("trg_operational_media_binding_mime_policy");
  });

  it("verifies expected producer rows independently of bindings, including shared storage keys", () => {
    const verify = fs.readFileSync(path.resolve("db/patches/support/20260823_operational_media_access_611.verify.sql"), "utf8");
    expect(verify).toContain("operational_media_expected_bindings_611");
    expect(verify).toContain("ON COMMIT PRESERVE ROWS");
    expect(verify).toContain("every_expected_producer_row_is_bound");
    expect(verify).toContain("count(DISTINCT storage_key) AS distinct_storage_keys");
    expect(verify).toContain("no_active_media_with_incompatible_binding_mime");
    expect(verify).toContain("('clients','client','client_id','logo_path','clients')");
    expect(verify).toContain("('fournisseurs','fournisseur','id','logo','fournisseurs')");
    expect(verify).toContain("('users','user','id','profile_picture','chat')");
  });

  it("ships a read-only preflight compatibility gate before legacy bytes can be reconciled", () => {
    const preflight = fs.readFileSync(path.resolve("db/patches/support/20260823_operational_media_access_611.preflight.sql"), "utf8");
    expect(preflight).toContain("OPERATIONAL_MEDIA_PREFLIGHT_COMPATIBILITY");
    expect(preflight).toContain("OPERATIONAL_MEDIA_PREFLIGHT_COMPATIBILITY_BLOCKED");
    expect(preflight).toContain("ARRAY['png','jpg','jpeg','webp','gif','pdf']");
    expect(preflight).toContain("ARRAY['png','jpg','jpeg','webp','gif']");
    expect(preflight).toContain("btrim(raw) ~* '^https?://'");
    expect(preflight).toContain("WHERE value IN ('.', '..') OR value = ''");
    expect(preflight).toContain("normalized_source ~ '[[:cntrl:]]'");
    expect(preflight).toContain("normalized_source ~* '^[A-Za-z][A-Za-z0-9+.-]*:'");
    expect(preflight).toContain("string_to_array(normalized_source, '/')");
    expect(preflight).not.toContain("fn_operational_media_normalize_key");
  });

  it("ships a built-runtime reconciliation command rather than a source-only entrypoint", () => {
    expect(packageJson.scripts?.["operational-media:reconcile"])
      .toBe("node dist/module/operational-media/scripts/reconcile-legacy.js");
  });
});
