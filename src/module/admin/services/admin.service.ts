import bcrypt from "bcryptjs";
import crypto from "node:crypto";

import { normalizeAssignedRoles } from "../../auth/domain/roles";
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
    password: _password,
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
  const passwordHash = await bcrypt.hash(input.password, 12);
  const { password: _password, ...provisioningInput } = input;
  return adminRepo.repoProvisionUser({
    ...provisioningInput,
    roles: normalizeAssignedRoles(input.role, input.roles),
    assignedBy: input.actorUserId,
    passwordHash,
    requestHash: buildProvisioningRequestHash(input),
  });
}

export async function updateUserByAdmin(
  userId: number,
  patch: Record<string, unknown>,
  assignedBy: number | null,
) {
  const updated = await adminRepo.repoUpdateUser(userId, {
    ...(patch as Parameters<typeof adminRepo.repoUpdateUser>[1]),
    assignedBy,
  });
  if ("role" in patch || "roles" in patch || "status" in patch) {
    await revokeUserRealtimeSessions(userId, { durable: false }).catch(() => undefined);
  }
  return updated;
}

export async function deleteUserByAdmin(userId: number) {
  const deleted = await adminRepo.repoDeleteUser(userId);
  await revokeUserRealtimeSessions(userId, { durable: false }).catch(() => undefined);
  return deleted;
}

export async function createPasswordResetTokenByAdmin(params: { userId: number }) {
  const raw = crypto.randomBytes(24).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const created = await adminRepo.repoCreatePasswordResetToken({
    userId: params.userId,
    tokenHash: hash,
    expiresAt,
  });
  return {
    token: raw,
    expires_at: created.expires_at,
    user_id: created.user_id,
    username: created.username,
  };
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
  token: string;
  newPassword: string;
}) {
  const hash = await bcrypt.hash(input.newPassword, 12);
  const userId = await adminRepo.repoResetUserPasswordWithToken({
    userId: input.userId,
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
