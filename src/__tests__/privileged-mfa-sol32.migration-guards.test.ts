import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("SOL-32 migration guards", () => {
  const patch = read("db/patches/20260815_privileged_mfa_sol32.sql");
  const preflight = read("db/patches/support/20260815_privileged_mfa_sol32.preflight.sql");
  const verify = read("db/patches/support/20260815_privileged_mfa_sol32.verify.sql");
  const rollback = read("db/patches/support/20260815_privileged_mfa_sol32.rollback.sql");
  const recoveryCli = read("scripts/auth/recover-privileged-mfa.mjs");

  it("stores only encrypted factor material and one-way challenge evidence", () => {
    expect(patch).toContain("encrypted_secret bytea NOT NULL");
    expect(patch).toContain("encryption_tag bytea NOT NULL");
    expect(patch).toContain("token_hash text NOT NULL UNIQUE");
    expect(patch).toContain("code_hash text NOT NULL");
    expect(patch).not.toMatch(/\bsecret\s+text\b/iu);
  });

  it("prevents concurrent active factors and bounds lifecycle state", () => {
    expect(patch).toContain("user_mfa_factors_one_active_uq");
    expect(patch).toContain("WHERE state = 'ACTIVE'");
    expect(patch).toContain("purpose IN ('LOGIN','ENROLL','REPLACE')");
    expect(verify).toContain("duplicate active factor");
  });

  it("ships preflight, postflight and evidence-preserving rollback", () => {
    expect(preflight).toContain("active_privileged_accounts");
    expect(verify).toContain("cerp_app grants are invalid");
    expect(rollback).toContain("rollback refused: enrolled or revoked MFA evidence exists");
  });

  it("keeps privileged recovery dry-run by default and auditable when applied", () => {
    expect(recoveryCli).toContain('process.argv.includes("--apply")');
    expect(recoveryCli).toContain("MFA_RECOVERY_APPROVAL");
    expect(recoveryCli).toContain("MFA_RECOVERY_REASON");
    expect(recoveryCli).toContain("AUTH_MFA_OUT_OF_BAND_RECOVERY");
    expect(recoveryCli).toContain("session_epoch=public.realtime_session_epochs.session_epoch+1");
    expect(patch).toContain("SELECT, INSERT, UPDATE, DELETE ON public.user_mfa_recovery_codes");
  });
});
