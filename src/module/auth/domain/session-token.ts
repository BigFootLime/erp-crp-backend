import crypto from "node:crypto";
import jwt from "jsonwebtoken";

import { authorizationRole, normalizeAssignedRoles } from "./roles";

export type SessionIdentity = {
  id: number;
  username: string;
  email: string | null;
  role: string;
  avatar_key?: string | null;
  profile_picture_asset_id?: string | null;
  roles?: string[] | null;
  realtime_session_epoch?: string | number | null;
};

export type MfaAssurance = {
  factorId: string;
  factorVersion: number;
  verifiedAt: Date;
  method: "totp" | "recovery_code";
};

export function issueSessionToken(user: SessionIdentity, mfa?: MfaAssurance, directory?:{session:string;profileId:string;membershipVersion:number;globalEpoch:number}) {
  const assignedRoles = normalizeAssignedRoles(user.role, user.roles ?? undefined);
  const effectiveRole = authorizationRole(user.role, assignedRoles);
  const parsedEpoch = Number.parseInt(String(user.realtime_session_epoch ?? "0"), 10);
  const sessionEpoch = Number.isSafeInteger(parsedEpoch) && parsedEpoch >= 0 ? parsedEpoch : 0;
  const payload = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: effectiveRole,
    avatar_key: user.avatar_key ?? null,
    primary_role: user.role,
    roles: assignedRoles,
    session_epoch: sessionEpoch,
    jti: crypto.randomUUID(),
    ...(directory?{directory_session:directory.session,directory_profile_id:directory.profileId,directory_membership_version:directory.membershipVersion,directory_global_epoch:directory.globalEpoch}:{}),
    ...(mfa ? {
      mfa: true,
      amr: ["pwd", mfa.method],
      mfa_verified_at: Math.floor(mfa.verifiedAt.getTime() / 1000),
      mfa_factor_id: mfa.factorId,
      mfa_factor_version: mfa.factorVersion,
    } : {}),
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "1d" });
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: effectiveRole,
      avatar_key: user.avatar_key ?? null,
      profile_picture_asset: user.profile_picture_asset_id ? {asset_id:user.profile_picture_asset_id,status:"AVAILABLE" as const}:null,
      primary_role: user.role,
      roles: assignedRoles,
    },
  };
}
