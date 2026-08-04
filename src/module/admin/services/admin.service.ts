import bcrypt from "bcryptjs";
import crypto from "node:crypto";

import { revokeUserRealtimeSessions } from "../../../sockets/sockeServer";
import * as adminRepo from "../repository/admin.repository";

export async function listUsers() {
  return adminRepo.repoListUsers();
}

export async function listRoles() {
  return adminRepo.repoListRoles();
}

export async function getUser(userId: number) {
  return adminRepo.repoGetUserById(userId);
}

export async function createUserByAdmin(input: {
  username: string;
  password: string;
  name: string;
  surname: string;
  email: string;
  tel_no: string | null;
  role: string;
  roles: string[];
  assignedBy: number | null;
  gender: string | null;
  address: string | null;
  lane: string | null;
  house_no: string | null;
  postcode: string | null;
  country: string | null;
  salary: number | null;
  date_of_birth: string | null;
  employment_date: string | null;
  employment_end_date: string | null;
  national_id: string | null;
  status: string | null;
  social_security_number: string | null;
}) {
  const hash = await bcrypt.hash(input.password, 12);
  return adminRepo.repoCreateUser({
    username: input.username,
    passwordHash: hash,
    name: input.name,
    surname: input.surname,
    email: input.email,
    tel_no: input.tel_no,
    role: input.role,
    roles: input.roles,
    assignedBy: input.assignedBy,
    gender: input.gender,
    address: input.address,
    lane: input.lane,
    house_no: input.house_no,
    postcode: input.postcode,
    country: input.country,
    salary: input.salary,
    date_of_birth: input.date_of_birth,
    employment_date: input.employment_date,
    employment_end_date: input.employment_end_date,
    national_id: input.national_id,
    status: input.status,
    social_security_number: input.social_security_number,
  });
}

export async function updateUserByAdmin(
  userId: number,
  patch: Record<string, unknown>,
  assignedBy: number | null
) {
  const updated = await adminRepo.repoUpdateUser(userId, {
    ...(patch as Parameters<typeof adminRepo.repoUpdateUser>[1]),
    assignedBy,
  });
  if ("role" in patch || "roles" in patch || "status" in patch) {
    // The durable transaction already bumped the session epoch. Local Socket.IO
    // delivery is best-effort and must not fail an otherwise committed mutation.
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
  // Durable password + epoch + token consumption is committed (or proven
  // committed) before local fan-out. Socket runtime failure cannot undo it.
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
