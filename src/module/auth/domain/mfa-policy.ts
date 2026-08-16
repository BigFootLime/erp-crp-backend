export const MFA_POLICIES = [
  "disabled",
  "optional",
  "required_for_admins",
  "required_for_all",
] as const;

export type MfaPolicy = (typeof MFA_POLICIES)[number];

export const DEFAULT_MFA_POLICY: MfaPolicy = "required_for_admins";

export function isMfaPolicy(value: unknown): value is MfaPolicy {
  return typeof value === "string" && (MFA_POLICIES as readonly string[]).includes(value);
}

export function normalizeMfaPolicy(value: unknown): MfaPolicy {
  return isMfaPolicy(value) ? value : DEFAULT_MFA_POLICY;
}

export function policyRequiresMfa(policy: MfaPolicy, isSuperadmin: boolean): boolean {
  if (policy === "required_for_all") return true;
  if (policy === "required_for_admins") return isSuperadmin;
  return false;
}

export function policyAllowsFactorRevocation(policy: MfaPolicy, isSuperadmin: boolean): boolean {
  return !policyRequiresMfa(policy, isSuperadmin);
}

/**
 * An active factor remains authoritative even if policy is relaxed. This
 * prevents an administrative policy change from silently downgrading users
 * who intentionally enrolled; they can revoke their factor through the
 * password + current-factor flow when policy allows it.
 */
export function accountRequiresMfa(params: {
  policy: MfaPolicy;
  isSuperadmin: boolean;
  hasActiveFactor: boolean;
}): boolean {
  return params.hasActiveFactor || policyRequiresMfa(params.policy, params.isSuperadmin);
}
