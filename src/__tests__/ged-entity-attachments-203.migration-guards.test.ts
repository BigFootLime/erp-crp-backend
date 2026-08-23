import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("GED-203 entity attachment migration guards", () => {
  const migration = read("db/patches/20260824_ged_entity_attachments_203.sql");
  const preflight = read("db/patches/support/20260824_ged_entity_attachments_203.preflight.sql");
  const verify = read("db/patches/support/20260824_ged_entity_attachments_203.verify.sql");
  const rollback = read("db/patches/support/20260824_ged_entity_attachments_203.rollback.sql");

  it("adds a constrained image class and a live GAMME parent guard", () => {
    expect(migration).toContain("'IMAGE_ENTITE'");
    expect(migration).toContain("ARRAY['image/jpeg','image/png','image/webp']");
    expect(migration).toContain("fn_ged_validate_gamme_entity_link_203");
    expect(migration).toContain("FROM public.gammes");
  });

  it("preflights historical links, verifies the class and refuses lossy rollback", () => {
    expect(preflight).toContain("GED203_PREFLIGHT_STALE_GAMME_LINKS");
    expect(preflight).toContain("backup_required_before_apply");
    expect(verify).toContain("GED203_VERIFY_IMAGE_CLASS_INVALID");
    expect(verify).toContain("GED203_VERIFY_GAMME_TRIGGER_MISSING");
    expect(rollback).toContain("GED203_ROLLBACK_REFUSED");
  });

  it("does not rewrite or label historical document versions", () => {
    expect(migration).not.toMatch(/UPDATE\s+public\.ged_document_versions/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.ged_upload_sessions/i);
  });
});
