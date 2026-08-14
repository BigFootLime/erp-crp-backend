import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const patch = fs.readFileSync(path.join(root, "db/patches/20260814_admin_operations_sol25.sql"), "utf8");
const preflight = fs.readFileSync(path.join(root, "db/patches/support/20260814_admin_operations_sol25.preflight.sql"), "utf8");
const verify = fs.readFileSync(path.join(root, "db/patches/support/20260814_admin_operations_sol25.verify.sql"), "utf8");
const rollback = fs.readFileSync(path.join(root, "db/patches/support/20260814_admin_operations_sol25.rollback.sql"), "utf8");
const runner = fs.readFileSync(path.join(root, "scripts/db-patches.js"), "utf8");

describe("SOL-25 migration guards", () => {
  it("is additive, transactional and preserves accounts and access decisions", () => {
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.app_access_reviews");
    expect(patch).toContain("app_access_reviews_single_open_uq");
    expect(patch).toContain("ADD COLUMN IF NOT EXISTS muted_until");
    expect(patch).not.toMatch(/\bDELETE\s+FROM\s+public\.(users|app_module_user_access)\b/i);
    expect(patch).not.toMatch(/\bTRUNCATE\b/i);
    expect(patch).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|TYPE)\b/i);
  });

  it("ships explicit preflight, verification and guarded physical rollback", () => {
    expect(preflight).toContain("public.auth_login_logs");
    expect(preflight).toContain("public.data_import_batches");
    expect(verify).toContain("SOL-25 access-review tables are missing");
    expect(rollback).toContain("cerp.allow_destructive_rollback");
    expect(rollback).toContain("Roll back the application first");
    expect(runner).toContain('"20260814_admin_operations_sol25.sql"');
    expect(runner).toContain("741a16b710835f4bc05dcac52c7ba5ceb74504c962bfe4307805d2071142d3f3");
  });
});
