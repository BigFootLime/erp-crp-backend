import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { sessionSignOptions } from "../../../config/deployment-security";
import { HttpError } from "../../../utils/httpError";

export const MAX_SESSION_SECONDS = 8 * 60 * 60;

export function assertSessionLifetime(startedAt: unknown, now = Math.floor(Date.now() / 1000)): asserts startedAt is number {
  if (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt <= 0 || startedAt > now + 60 || now - startedAt >= MAX_SESSION_SECONDS) {
    throw new HttpError(401, "SESSION_MAX_AGE_REACHED", "Veuillez vous reconnecter pour ouvrir une nouvelle session.");
  }
}

/** Accept only claims already authenticated by authenticateToken, never request input. */
export function renewSessionToken(claims: NonNullable<Express.Request["user"]>): string {
  const startedAt = claims.session_started_at ?? claims.iat;
  assertSessionLifetime(startedAt);
  // Keep the original assurance time, factor version, revocation epoch and
  // directory binding. Renewal is not a fresh password or MFA verification.
  const payload = {
    id: claims.id, username: claims.username, email: claims.email, role: claims.role,
    primary_role: claims.primary_role, roles: claims.roles, avatar_key: claims.avatar_key,
    session_epoch: claims.session_epoch, session_started_at: startedAt,
    mfa: claims.mfa, amr: claims.amr, mfa_verified_at: claims.mfa_verified_at,
    mfa_factor_id: claims.mfa_factor_id, mfa_factor_version: claims.mfa_factor_version,
    directory_session: claims.directory_session, directory_profile_id: claims.directory_profile_id,
    directory_global_epoch: claims.directory_global_epoch, directory_membership_version: claims.directory_membership_version,
    jti: crypto.randomUUID(),
  };
  return jwt.sign(payload, process.env.JWT_SECRET as string, sessionSignOptions());
}
