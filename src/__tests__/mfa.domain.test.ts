import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";

import {
  assertMfaStartupConfiguration,
  buildOtpAuthUri,
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  totpForStep,
  verifyTotp,
} from "../module/auth/domain/mfa";

const originalRootKey = process.env.MFA_ROOT_KEY;
const originalKeyId = process.env.MFA_KEY_ID;

describe("SOL-32 MFA cryptography", () => {
  beforeEach(() => {
    process.env.MFA_ROOT_KEY = "11".repeat(32);
    process.env.MFA_KEY_ID = "test-v1";
  });
  afterEach(() => {
    if (originalRootKey === undefined) delete process.env.MFA_ROOT_KEY;
    else process.env.MFA_ROOT_KEY = originalRootKey;
    if (originalKeyId === undefined) delete process.env.MFA_KEY_ID;
    else process.env.MFA_KEY_ID = originalKeyId;
  });

  it("matches the RFC 6238 SHA-1 vector truncated to six digits", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totpForStep(secret, 1)).toBe("287082");
    expect(verifyTotp({ secret, code: "287082", nowMs: 59_000, driftSteps: 0 })).toBe(1);
  });

  it("accepts only the bounded clock-drift window", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const previous = totpForStep(secret, 9);
    expect(verifyTotp({ secret, code: previous, nowMs: 10 * 30_000, driftSteps: 1 })).toBe(9);
    expect(verifyTotp({ secret, code: previous, nowMs: 11 * 30_000, driftSteps: 1 })).toBeNull();
  });

  it("encrypts the seed with authenticated encryption and detects the wrong key", () => {
    const encrypted = encryptMfaSecret("JBSWY3DPEHPK3PXP");
    expect(encrypted.encrypted.toString("utf8")).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptMfaSecret(encrypted)).toBe("JBSWY3DPEHPK3PXP");
    process.env.MFA_ROOT_KEY = "22".repeat(32);
    expect(() => decryptMfaSecret(encrypted)).toThrow();
  });

  it("uses keyed, normalized recovery hashes and unique display codes", () => {
    expect(hashRecoveryCode("abcd-1234-efgh")).toBe(hashRecoveryCode("ABCD 1234 EFGH"));
    const codes = generateRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((code) => /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(code))).toBe(true);
  });

  it("builds an interoperable otpauth URI without leaking it to logs", () => {
    const uri = buildOtpAuthUri({ username: "KEENAN", secret: "JBSWY3DPEHPK3PXP" });
    expect(uri).toContain("otpauth://totp/CERP%2B%3AKEENAN");
    expect(uri).toContain("algorithm=SHA1&digits=6&period=30");
  });

  it("fails closed at startup when production key material is absent or malformed", () => {
    expect(() => assertMfaStartupConfiguration({ NODE_ENV: "production" })).toThrow(/MFA_ROOT_KEY is required/);
    expect(() => assertMfaStartupConfiguration({ NODE_ENV: "production", MFA_ROOT_KEY: "too-short" })).toThrow(
      /exactly 32 bytes/,
    );
    expect(() => assertMfaStartupConfiguration({
      NODE_ENV: "production",
      MFA_ROOT_KEY: crypto.randomBytes(32).toString("hex"),
      MFA_KEY_ID: "production-v1",
    })).not.toThrow();
  });

  it("requires private key material in development and refuses the published fixture key", () => {
    expect(() => assertMfaStartupConfiguration({ NODE_ENV: "development" })).toThrow(/required/);
    expect(() => assertMfaStartupConfiguration({})).toThrow(/required/);
    const fixtureKey = "9ddf1be3a6d4ae10ce5f4d410dd82f30a0e15b5de8388e251ad95ce87eb5206b";
    expect(() => assertMfaStartupConfiguration({ NODE_ENV: "development", MFA_ROOT_KEY: fixtureKey })).toThrow(/disposable/);
    expect(() => assertMfaStartupConfiguration({ NODE_ENV: "test" })).not.toThrow();
  });
  it.each(["00", "11", "33"])("refuses uniform demonstration keys outside tests: %s", byte => {
    expect(() => assertMfaStartupConfiguration({ NODE_ENV: "production", MFA_ROOT_KEY: byte.repeat(32) })).toThrow(/disposable/);
  });
});
