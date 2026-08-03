import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/repo-paths";

const root = repoRoot;
const patch = readFileSync(
  resolve(root, "db/patches/20260801_piece_version_guided_publish_trigger.sql"),
  "utf8"
);
const verify = readFileSync(
  resolve(root, "db/patches/support/20260801_piece_version_guided_publish_trigger.verify.sql"),
  "utf8"
);
const rollback = readFileSync(
  resolve(root, "db/patches/support/20260801_piece_version_guided_publish_trigger.rollback.sql"),
  "utf8"
);

describe("#461 guided technical-version publication migration guards", () => {
  it("keeps validated technical content immutable", () => {
    expect(patch).toContain("Validated technical versions are retained for traceability");
    expect(patch).toContain("Validated technical versions are immutable; create a new version instead");
    expect(patch).toContain("OLD.statut = 'APPLICABLE'");
    expect(patch).toContain("NEW.statut = 'OBSOLETE'");
  });

  it("only permits advancing a still-future effective date", () => {
    expect(patch).toContain("OLD.date_effet > CURRENT_DATE");
    expect(patch).toContain("NEW.date_effet IS NULL OR NEW.date_effet <= CURRENT_DATE");
    expect(patch).toContain("NEW.updated_by IS NOT NULL");
    expect(patch).toContain("ARRAY['date_effet', 'updated_at', 'updated_by']");
    expect(patch).not.toContain("document_requirements_frozen_at', 'updated_at'");
  });

  it("is transactional and does not rewrite business data", () => {
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
    expect(patch).not.toMatch(/\bUPDATE\s+public\.piece_technique_versions\b/i);
    expect(patch).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(patch).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("ships read-only verification and a non-destructive rollback", () => {
    expect(verify).toContain("pg_get_functiondef");
    expect(verify).toContain("trg_prevent_validated_piece_version_mutation");
    expect(rollback).toContain("CREATE OR REPLACE FUNCTION public.fn_prevent_validated_piece_version_mutation");
    expect(rollback).not.toMatch(/\bUPDATE\s+public\.piece_technique_versions\b/i);
    expect(rollback).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
