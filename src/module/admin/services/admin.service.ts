// src/module/admin/services/admin.service.ts
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import * as adminRepo from "../repository/admin.repository";
import { HttpError } from "../../../utils/httpError";

export async function listUsers() {
  return adminRepo.repoListUsers();
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
  tel_no: string;
  role: string;
  gender: string;
  address: string;
  lane: string;
  house_no: string;
  postcode: string;
  country: string | null;
  salary: number | null;
  date_of_birth: string;
  employment_date: string | null;
  employment_end_date: string | null;
  national_id: string | null;
  status: string | null;
  social_security_number: string;
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

export async function updateUserByAdmin(userId: number, patch: Record<string, unknown>) {
  // Controller/validator ensures correct shape; keep narrow casting here.
  return adminRepo.repoUpdateUser(userId, patch as Parameters<typeof adminRepo.repoUpdateUser>[1]);
}

export async function deleteUserByAdmin(userId: number) {
  return adminRepo.repoDeleteUser(userId);
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
  success: string; // "true" | "false" | ""
  username: string;
}) {
  return adminRepo.repoListLoginLogs(filters);
}

export async function resetUserPasswordByAdmin(input: {
  userId: string;
  token: string;
  newPassword: string;
  // adminId?: string | null;
}) {
  // 1) verify token row
  const tokenRow = await adminRepo.repoFindResetTokenForUser(input.userId, input.token);

  if (!tokenRow) {
    throw new HttpError(400, "RESET_TOKEN_INVALID", "Token invalide ou expiré.");
  }
  if (tokenRow.used_at) {
    throw new HttpError(400, "RESET_TOKEN_USED", "Ce token a déjà été utilisé.");
  }
  if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
    throw new HttpError(400, "RESET_TOKEN_EXPIRED", "Token expiré. Demandez une nouvelle réinitialisation.");
  }

  // 2) update password hash
  const hash = await bcrypt.hash(input.newPassword, 12);
  await adminRepo.repoUpdateUserPassword(input.userId, hash);

  // 3) mark token used
  await adminRepo.repoMarkResetTokenUsed(tokenRow.id);

  // optional audit log if you have a table
  // await adminRepo.repoInsertAdminAudit({ adminId: input.adminId, action: "RESET_PASSWORD", targetUserId: input.userId });
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
