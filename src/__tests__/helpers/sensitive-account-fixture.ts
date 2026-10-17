import type { Request } from "express";
import { SENSITIVE_CAPABILITIES, type AccountCapabilityState, type SensitiveCapability } from "../../module/access-control/domain/sensitive-capabilities";
const decisions = new Map<number, readonly SensitiveCapability[]>();
export const ALL_FIXTURE_SENSITIVE_RIGHTS = SENSITIVE_CAPABILITIES;
/** Only explicitly passed fixture grants populate this registry; role titles do not. */
export function attachSensitiveAccountFixture(req: Request, rights: readonly SensitiveCapability[]) {
  if (!req.user) return;
  decisions.set(req.user.id, rights);
  req.user.mfa = true; req.user.amr = ["pwd", "totp"];
  req.user.mfa_verified_at = Math.floor(Date.now() / 1000);
}
export async function readSensitiveAccountFixture(userId: number): Promise<AccountCapabilityState> {
  return { active: true, isSuperadmin: false, capabilities: [...(decisions.get(userId) ?? [])] };
}
