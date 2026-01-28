// src/module/admin/services/admin.service.ts
import bcrypt from "bcrypt";
import * as adminRepo from "../repository/admin.repository";

export async function listUsers() {
  return adminRepo.repoListUsers();
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
    const err = new Error("Token invalide ou expiré.");
    (err as any).status = 400;
    throw err;
  }
  if (tokenRow.used_at) {
    const err = new Error("Ce token a déjà été utilisé.");
    (err as any).status = 400;
    throw err;
  }
  if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
    const err = new Error("Token expiré. Demandez une nouvelle réinitialisation.");
    (err as any).status = 400;
    throw err;
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
