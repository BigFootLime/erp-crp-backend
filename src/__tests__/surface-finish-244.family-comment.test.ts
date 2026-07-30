import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8").replace(/\r\n?/g, "\n");

const patch = read("db/patches/20260730_surface_finish_family_comment_244.sql");
const preflight = read("db/patches/support/20260730_surface_finish_family_comment_244.preflight.sql");
const verify = read("db/patches/support/20260730_surface_finish_family_comment_244.verify.sql");
const library = read("src/module/surface-finish/repository/surface-finish-library.repository.ts");
const resolution = read("src/module/surface-finish/repository/surface-finish-resolution.repository.ts");
const routes = read("src/module/surface-finish/routes/surface-finish.routes.ts");

describe("#244 commentaire de famille de finition", () => {
  it("est additif, transactionnel et ne modifie aucun article existant", () => {
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
    expect(patch).toMatch(/ADD COLUMN IF NOT EXISTS\s+commentaire_template\s+text NULL/i);
    expect(patch).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bINSERT\b/i);
  });

  it("borne le modèle et livre les contrôles de migration lecture seule", () => {
    expect(patch).toContain("surface_finish_families_commentaire_template_length_check");
    expect(patch).toContain("char_length(commentaire_template) <= 4000");
    expect(preflight).toContain("\\set ON_ERROR_STOP on");
    expect(verify).toContain("\\set ON_ERROR_STOP on");
    expect(preflight).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
    expect(verify).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
    expect(verify).toContain("comment_column_exists");
    expect(verify).toMatch(/configured_families\s*\nFROM public\.surface_finish_families;/);
  });

  it("compose le commentaire de famille dans le même rendu pour aperçu et confirmation", () => {
    expect(resolution).toContain("fam.commentaire_template AS family_commentaire_template");
    expect(resolution).toContain("LEFT JOIN public.surface_finish_families fam");
    expect(resolution).toContain("[familyTemplate, revisionTemplate].filter(Boolean).join");
    expect(routes).toContain('router.post(\n  "/familles",');
    expect(routes).toContain('requireSurfaceFinishCapability("library_draft_write")');
  });

  it("crée la famille et sa trace d'audit dans une seule transaction", () => {
    expect(library).toContain('await client.query("BEGIN")');
    expect(library).toContain('await insertFinishAudit(client, audit, "finitions.family.create"');
    expect(library).toContain('await client.query("COMMIT")');
    expect(library).toContain('await client.query("ROLLBACK").catch');
  });
});
