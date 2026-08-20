import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const name = "20260819_mfa_expired_artifact_cleanup_delete_grant";
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");
const migration = read(`db/patches/${name}.sql`);
const preflight = read(`db/patches/support/${name}.preflight.sql`);
const verify = read(`db/patches/support/${name}.verify.sql`);
const rollback = read(`db/patches/support/${name}.rollback.sql`);
const runner = read("scripts/db-patches.js");
const mfaService = read("src/module/auth/services/mfa.service.ts");

describe("CERP-REPAIR-00 MFA expired artifact cleanup grant", () => {
  it("grants only the DELETE operation used by maintenance", () => {
    expect(migration).toContain("GRANT DELETE ON TABLE public.user_mfa_factors TO cerp_app");
    expect(migration).not.toMatch(/GRANT\s+(ALL|SELECT|INSERT|UPDATE|TRUNCATE)/i);
    expect(mfaService).toContain("DELETE FROM public.user_mfa_factors");
    expect(mfaService).toContain("state='PENDING'");
  });

  it("ships target guards and read-only preflight and verification", () => {
    for (const relation of ["user_mfa_factors", "auth_mfa_challenges"]) {
      expect(migration).toContain(relation);
      expect(preflight).toContain(relation);
    }
    expect(migration).toContain("runtime role cerp_app is missing");
    expect(preflight).toContain("BEGIN TRANSACTION READ ONLY");
    expect(preflight).toContain("has_table_privilege('cerp_app', 'public.user_mfa_factors', 'DELETE')");
    expect(verify).toContain("cannot delete expired pending MFA factors");
    expect(verify).toContain("has_table_privilege('cerp_app', 'public.user_mfa_factors', 'DELETE')");
    expect(preflight).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/im);
    expect(verify).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/im);
  });

  it("has a bounded rollback to the documented SOL-32 privilege baseline", () => {
    expect(rollback).toContain("Roll back the matching");
    expect(rollback).toContain("REVOKE DELETE ON TABLE public.user_mfa_factors FROM cerp_app");
    expect(rollback).not.toMatch(/REVOKE\s+(ALL|SELECT|INSERT|UPDATE|TRUNCATE)/i);
  });

  it("pins the additive patch in the immutable migration registry", () => {
    const sha256 = createHash("sha256").update(migration.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
    expect(runner).toContain(`\"${name}.sql\":`);
    expect(runner).toContain(sha256);
  });
});
