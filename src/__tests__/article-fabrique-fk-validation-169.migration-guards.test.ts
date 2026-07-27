import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const patch = fs.readFileSync(
  path.join(root, "db/patches/20260727_validate_article_fabrique_references_169.sql"),
  "utf8"
);
const preflight = fs.readFileSync(
  path.join(root, "db/patches/support/20260727_validate_article_fabrique_references_169.preflight.sql"),
  "utf8"
);
const verify = fs.readFileSync(
  path.join(root, "db/patches/support/20260727_validate_article_fabrique_references_169.verify.sql"),
  "utf8"
);
const rollback = fs.readFileSync(
  path.join(root, "db/patches/support/20260727_validate_article_fabrique_references_169.rollback.sql"),
  "utf8"
);
const patchSql = patch.replace(/^--.*$/gm, "");

const constraintNames = [
  "commande_ligne_article_fabrique_fk",
  "commande_cadre_release_ligne_article_fabrique_fk",
  "ordres_fabrication_article_fabrique_fk",
];

describe("article fabrique FK validation #169 migration guards", () => {
  it("validates exactly the three known historical constraints", () => {
    for (const name of constraintNames) {
      expect(patch).toContain(`VALIDATE CONSTRAINT ${name}`);
      expect(preflight).toContain(name);
      expect(verify).toContain(name);
    }
    expect(patch.match(/VALIDATE CONSTRAINT/g)).toHaveLength(3);
  });

  it("proves references before changing validation metadata", () => {
    expect(patch).toContain("articles_fabrique AS target");
    expect(patch).toContain("invalid_reference");
    expect(patch.indexOf("invalid_reference")).toBeLessThan(
      patch.indexOf("VALIDATE CONSTRAINT")
    );
    expect(preflight).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
  });

  it("never changes business rows", () => {
    expect(patchSql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(patchSql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(patch).toMatch(/BEGIN;/);
    expect(patch).toMatch(/COMMIT;/);
  });

  it("keeps rollback test-only and restores NOT VALID definitions", () => {
    expect(rollback).toMatch(/current_database\(\) <> 'cerp_test'/);
    expect(rollback.match(/NOT VALID/g)).toHaveLength(3);
    expect(rollback).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });
});
