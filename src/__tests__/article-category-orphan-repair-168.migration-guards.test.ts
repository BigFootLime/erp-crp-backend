import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const patch = fs.readFileSync(
  path.join(root, "db/patches/20260727_repair_article_category_orphans_168.sql"),
  "utf8"
);
const preflight = fs.readFileSync(
  path.join(root, "db/patches/support/20260727_repair_article_category_orphans_168.preflight.sql"),
  "utf8"
);
const verify = fs.readFileSync(
  path.join(root, "db/patches/support/20260727_repair_article_category_orphans_168.verify.sql"),
  "utf8"
);
const rollback = fs.readFileSync(
  path.join(root, "db/patches/support/20260727_repair_article_category_orphans_168.rollback.sql"),
  "utf8"
);

describe("article category orphan repair #168 migration guards", () => {
  it("pins the exact source and evidence hashes", () => {
    for (const sql of [patch, preflight, verify]) {
      expect(sql).toContain("454eeddc3ac8518e63994a8d0da03206");
      expect(sql).toContain("01dfd9678e74320d49b1ec3a727ed3b370e8910a07cffb5b350cbaf4ba7189ac");
      expect(sql).toContain("c9b95a94ebcf93041b6f325b84d90e0f8cb3a50b1cbc788c3061d173cef3026d");
    }
  });

  it("keeps the repair transactional, locked and audit-first", () => {
    expect(patch).toMatch(/BEGIN;/);
    expect(patch).toMatch(/LOCK TABLE public\.article_category_link IN SHARE ROW EXCLUSIVE MODE/);
    expect(patch).toContain("INSERT INTO public.erp_audit_logs");
    expect(patch).toContain("'ACTION'");
    expect(patch).not.toContain("'DATA_REPAIR'");
    expect(patch).toContain("original_links");
    expect(patch).toContain("DELETE FROM public.article_category_link");
    expect(patch.indexOf("INSERT INTO public.erp_audit_logs")).toBeLessThan(
      patch.indexOf("DELETE FROM public.article_category_link")
    );
    expect(patch).toMatch(/VALIDATE CONSTRAINT article_category_link_article_id_fkey/);
    expect(patch).toMatch(/COMMIT;/);
  });

  it("refuses broad or unexpected repairs", () => {
    expect(patch).toMatch(/current_database\(\) NOT IN \('cerp_test', 'cerp_prod'\)/);
    expect(patch).toContain("unexpected reference");
    expect(patch).toContain("expected to remove two links");
    expect(patch).not.toMatch(/DELETE\s+FROM\s+public\.articles/i);
    expect(patch).not.toMatch(/TRUNCATE/i);
    expect(patch).not.toMatch(/DROP\s+TABLE/i);
  });

  it("provides read-only preflight and complete verification", () => {
    expect(preflight).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
    expect(preflight).toContain("unexpected reference");
    expect(verify).toContain("no_orphan_category_links");
    expect(verify).toContain("article_category_fk_validated");
    expect(verify).toContain("all_public_foreign_keys_validated");
  });

  it("restricts rollback to cerp_test and restores only audited rows", () => {
    expect(rollback).toMatch(/current_database\(\) <> 'cerp_test'/);
    expect(rollback).toContain("jsonb_array_elements");
    expect(rollback).toContain("original_links");
    expect(rollback).toContain("restored <> 2");
    expect(rollback).toMatch(/NOT VALID/);
    expect(rollback).toContain("'ACTION'");
    expect(rollback).not.toContain("'DATA_REPAIR'");
    expect(rollback).not.toMatch(/DELETE\s+FROM/i);
  });
});
