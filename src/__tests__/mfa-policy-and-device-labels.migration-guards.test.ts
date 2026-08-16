import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) => readFileSync(path.resolve(relativePath), "utf8");

describe("DOCS-MFA-01 migration guardrails", () => {
  const patch = read("db/patches/20260816_mfa_policy_and_device_labels.sql");
  const preflight = read("db/patches/support/20260816_mfa_policy_and_device_labels.preflight.sql");
  const verify = read("db/patches/support/20260816_mfa_policy_and_device_labels.verify.sql");
  const rollback = read("db/patches/support/20260816_mfa_policy_and_device_labels.rollback.sql");

  it("keeps the previous privileged policy as the replay-safe default", () => {
    expect(patch).toContain("required_for_admins");
    expect(patch).toContain("ON CONFLICT (key) DO NOTHING");
    expect(patch).toContain("security.mfa_policy");
  });

  it("adds bounded device labels without rewriting active secrets", () => {
    expect(patch).toContain("ADD COLUMN IF NOT EXISTS device_label");
    expect(patch).toContain("user_mfa_factor_device_label_ck");
    expect(patch).not.toMatch(/UPDATE\s+public\.user_mfa_factors[\s\S]+encrypted_secret/i);
  });

  it("provides preflight, post-migration verification and guarded rollback", () => {
    expect(preflight).toContain("Required SOL-32/SOL-06 relations are missing");
    expect(verify).toContain("MFA policy is absent or invalid");
    expect(rollback).toContain("rollback refused: MFA policy was changed after migration");
    expect(rollback).toContain("rollback refused: non-superadmin MFA lifecycle evidence exists");
  });

  it("is included in the isolated release rehearsal and rollback proof", () => {
    const gate = read("scripts/migrations/release-gate.js");
    expect(gate).toContain('const MFA_POLICY_PATCH = "20260816_mfa_policy_and_device_labels.sql"');
    expect(gate).toContain('patchSupportSql(MFA_POLICY_PATCH, "rollback")');
    expect(gate).toContain("mfa_policy_removed");
  });
});
