import { describe, expect, it } from "vitest";

import {
  accountRequiresMfa,
  DEFAULT_MFA_POLICY,
  normalizeMfaPolicy,
  policyAllowsFactorRevocation,
  policyRequiresMfa,
} from "../module/auth/domain/mfa-policy";

describe("MFA policy", () => {
  it("preserves the SOL-32 admin requirement when the setting is absent or invalid", () => {
    expect(normalizeMfaPolicy(null)).toBe(DEFAULT_MFA_POLICY);
    expect(normalizeMfaPolicy("invalid")).toBe("required_for_admins");
  });

  it.each([
    ["disabled", true, false],
    ["optional", true, false],
    ["required_for_admins", false, false],
    ["required_for_admins", true, true],
    ["required_for_all", false, true],
    ["required_for_all", true, true],
  ] as const)("evaluates %s for isSuperadmin=%s", (policy, isSuperadmin, expected) => {
    expect(policyRequiresMfa(policy, isSuperadmin)).toBe(expected);
  });

  it("never bypasses an already enrolled factor when policy is relaxed", () => {
    expect(accountRequiresMfa({ policy: "disabled", isSuperadmin: false, hasActiveFactor: true })).toBe(true);
    expect(accountRequiresMfa({ policy: "optional", isSuperadmin: false, hasActiveFactor: false })).toBe(false);
  });

  it.each([
    ["disabled", false, true],
    ["optional", true, true],
    ["required_for_admins", false, true],
    ["required_for_admins", true, false],
    ["required_for_all", false, false],
    ["required_for_all", true, false],
  ] as const)("allows revocation for %s and isSuperadmin=%s only when policy permits it", (policy, isSuperadmin, expected) => {
    expect(policyAllowsFactorRevocation(policy, isSuperadmin)).toBe(expected);
  });
});
