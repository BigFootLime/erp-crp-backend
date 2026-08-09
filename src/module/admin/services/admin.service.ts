import bcrypt from "bcryptjs";
import crypto from "node:crypto";

import { normalizeAssignedRoles } from "../../auth/domain/roles";
import {
  hashAccountInvitationToken,
  signAccountInvitationToken,
} from "../../auth/domain/account-invitation";
import { HttpError } from "../../../utils/httpError";
import { revokeUserRealtimeSessions } from "../../../sockets/sockeServer";
import * as adminRepo from "../repository/admin.repository";
import type { AdminCreateUserDTO } from "../validators/admin.validators";

type ProvisionUserInput = AdminCreateUserDTO["body"] & {
  actorUserId: number;
  idempotencyKey: string;
};

export async function listUsers() {
  return adminRepo.repoListUsers();
}

export async function listRoles() {
  return adminRepo.repoListRoles();
}

export async function getUser(userId: number) {
  return adminRepo.repoGetUserById(userId);
}

export function buildProvisioningRequestHash(input: ProvisionUserInput): string {
  const {
    actorUserId: _actorUserId,
    idempotencyKey: _idempotencyKey,
    ...nonSecretFields
  } = input;
  const canonical = JSON.stringify({
    ...nonSecretFields,
    roles: normalizeAssignedRoles(input.role, input.roles),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export async function createUserByAdmin(input: ProvisionUserInput) {
  // The administrator never knows the invited user's password. This random
  // unusable bootstrap secret is replaced only by successful activation.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString("base64url"), 12);
  return adminRepo.repoProvisionUser({
    ...input,
    roles: normalizeAssignedRoles(input.role, input.roles),
    assignedBy: input.actorUserId,
    passwordHash,
    requestHash: buildProvisioningRequestHash(input),
  });
}

export async function updateUserByAdmin(
  userId: number,
  patch: Record<string, unknown>,
  actorUserId: number,
) {
  if (userId === actorUserId && patch.status !== undefined && patch.status !== "Active") {
    throw new HttpError(
      409,
      "SELF_DEACTIVATION_FORBIDDEN",
      "Un administrateur ne peut pas désactiver son propre compte.",
    );
  }
  const updated = await adminRepo.repoUpdateUser(userId, {
    ...(patch as Parameters<typeof adminRepo.repoUpdateUser>[1]),
    assignedBy: actorUserId,
  }, actorUserId);
  if ("role" in patch || "roles" in patch || "status" in patch) {
    await revokeUserRealtimeSessions(userId, { durable: false }).catch(() => undefined);
  }
  return updated;
}

export function buildInvitationRequestHash(input: {
  userId: number;
  actorUserId: number;
}): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ actorUserId: input.actorUserId, userId: input.userId }))
    .digest("hex");
}

export async function createAccountInvitationByAdmin(input: {
  userId: number;
  actorUserId: number;
  idempotencyKey: string;
}) {
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
  const candidate = {
    invitationId: id,
    userId: input.userId,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  const candidateToken = signAccountInvitationToken(candidate);
  const result = await adminRepo.repoCreateAccountInvitation({
    id,
    userId: input.userId,
    actorUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
    requestHash: buildInvitationRequestHash(input),
    tokenHash: hashAccountInvitationToken(candidateToken),
    createdAt: candidate.createdAt,
    expiresAt: candidate.expiresAt,
  });
  const token = signAccountInvitationToken({
    invitationId: result.invitation.id,
    userId: result.invitation.user_id,
    createdAt: result.invitation.created_at,
    expiresAt: result.invitation.expires_at,
  });
  if (hashAccountInvitationToken(token) !== result.invitation.token_hash) {
    throw new HttpError(
      409,
      "INVITATION_REPLAY_UNAVAILABLE",
      "L'invitation existe mais son lien ne peut pas être rejoué en sécurité.",
    );
  }
  return {
    invitation: {
      id: result.invitation.id,
      user_id: result.invitation.user_id,
      username: result.invitation.username,
      expires_at: result.invitation.expires_at,
      activation_path: `/activate?token=${encodeURIComponent(token)}`,
      token,
    },
    replayed: result.replayed,
  };
}

export async function createPasswordResetTokenByAdmin(params: {
  userId: number;
  actorUserId: number;
  idempotencyKey: string;
}) {
  const tokenId = crypto.randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 60 * 60 * 1000);
  const requestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ actorUserId: params.actorUserId, userId: params.userId }))
    .digest("hex");
  const raw = signAdminPasswordResetToken({
    tokenId,
    userId: params.userId,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const created = await adminRepo.repoCreatePasswordResetToken({
    tokenId,
    userId: params.userId,
    actorUserId: params.actorUserId,
    idempotencyKey: params.idempotencyKey,
    requestHash,
    tokenHash: hash,
    createdAt,
    expiresAt,
  });
  const replayToken = signAdminPasswordResetToken({
    tokenId: created.token_id,
    userId: created.user_id,
    createdAt: created.created_at,
    expiresAt: created.expires_at,
  });
  if (crypto.createHash("sha256").update(replayToken).digest("hex") !== created.token_hash) {
    throw new HttpError(409, "RESET_REPLAY_UNAVAILABLE", "Le token ne peut pas être rejoué en sécurité.");
  }
  return {
    token: replayToken,
    expires_at: created.expires_at,
    user_id: created.user_id,
    username: created.username,
    replayed: created.replayed,
  };
}

function signAdminPasswordResetToken(input: {
  tokenId: string;
  userId: number;
  createdAt: string;
  expiresAt: string;
}): string {
  const secret = (process.env.JWT_SECRET ?? "").trim();
  if (!secret) throw new Error("JWT_SECRET is required for administrative password reset");
  const tokenPayload = Buffer.from(JSON.stringify({
    purpose: "cerp-admin-password-reset-v1",
    tokenId: input.tokenId,
    userId: input.userId,
    createdAt: new Date(input.createdAt).toISOString(),
    expiresAt: new Date(input.expiresAt).toISOString(),
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(tokenPayload).digest("base64url");
  return `v1.${tokenPayload}.${signature}`;
}

export async function listLoginLogs(filters: {
  from: string;
  to: string;
  success: string;
  username: string;
}) {
  return adminRepo.repoListLoginLogs(filters);
}

export async function resetUserPasswordByAdmin(input: {
  userId: string;
  actorUserId: number;
  token: string;
  newPassword: string;
}) {
  const hash = await bcrypt.hash(input.newPassword, 12);
  const userId = await adminRepo.repoResetUserPasswordWithToken({
    userId: input.userId,
    actorUserId: input.actorUserId,
    rawToken: input.token,
    passwordHash: hash,
  });
  await revokeUserRealtimeSessions(userId, { durable: false }).catch(() => undefined);
}

export async function getAnalytics(filters: {
  from: string;
  to: string;
  success: string;
  role: string;
  status: string;
}) {
  return adminRepo.repoGetAdminAnalytics(filters);
}
