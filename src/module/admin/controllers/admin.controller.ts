import type { RequestHandler } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { ordinaryAccountInput, privateAccountPatchSchema } from "../domain/private-account-data";
import { repoGetUserById } from "../repository/admin.repository";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import * as adminService from "../services/admin.service";
import pool from '../../../config/database';
import {sharedDirectoryClient} from '../../../shared-directory/site-runtime';
import {directoryAdminList,directoryAdminUser,directoryAdminToken,directoryAdminCall,directoryTargetId,directoryAdminSuperadmin} from '../../../shared-directory/admin.facade';
import { recoverAccountBySuperadmin } from "../services/account-recovery.service";
import {
  adminCreateUserSchema,
  adminCreateInvitationSchema,
  adminCreatePasswordResetSchema,
  adminRecoverAccountSchema,
  adminUpdateUserSchema,
  adminAdministrativeLevelSchema,
  adminUserIdParamSchema,
  adminErpSettingKeySchema,
  adminUpsertErpSettingSchema,
  resetPasswordByAdminSchema,
} from "../validators/admin.validators";

export const listUsersAdmin: RequestHandler = asyncHandler(async (req, res) => {
  if(sharedDirectoryClient()){res.json(await directoryAdminList(pool,req));return;}
  res.json(await adminService.listUsers());
});

export const listRolesAdmin: RequestHandler = asyncHandler(async (_req, res) => {
  res.json(await adminService.listRoles());
});

export const listLoginLogsAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const from = (req.query as { from?: unknown }).from;
  const to = (req.query as { to?: unknown }).to;
  const success = (req.query as { success?: unknown }).success;
  const username = (req.query as { username?: unknown }).username;
  res.json(await adminService.listLoginLogs({
    from: typeof from === "string" ? from : "",
    to: typeof to === "string" ? to : "",
    success: typeof success === "string" ? success : "",
    username: typeof username === "string" ? username : "",
  }));
});

export const getAdminAnalytics: RequestHandler = asyncHandler(async (req, res) => {
  const from = (req.query as { from?: unknown }).from;
  const to = (req.query as { to?: unknown }).to;
  const success = (req.query as { success?: unknown }).success;
  const role = (req.query as { role?: unknown }).role;
  const status = (req.query as { status?: unknown }).status;
  res.json(await adminService.getAnalytics({
    from: typeof from === "string" ? from : "",
    to: typeof to === "string" ? to : "",
    success: typeof success === "string" ? success : "",
    role: typeof role === "string" ? role : "",
    status: typeof status === "string" ? status : "",
  }));
});

export const getUserAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminUserIdParamSchema.parse({ params: req.params });
  if(sharedDirectoryClient()){res.json(await directoryAdminUser(pool,req,'admin-user',{profile_id:await directoryTargetId(pool,Number(dto.params.id))}));return;}
  const user = await adminService.getUser(Number(dto.params.id));
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  res.json({ user });
});

export const createUserAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminCreateUserSchema.parse({
    headers: { idempotencyKey: req.get("Idempotency-Key") },
    body: ordinaryAccountInput(req.body),
  });
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise");

  const result = sharedDirectoryClient()?await directoryAdminUser(pool,req,'admin-user-create',dto):await adminService.createUserByAdmin({
    ...dto.body,
    actorUserId: req.user.id,
    idempotencyKey: dto.headers.idempotencyKey,
  });
  res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
  res.status(result.replayed ? 200 : 201).json(result);
});

export const patchUserAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminUpdateUserSchema.parse({ params: req.params, body: ordinaryAccountInput(req.body) });
  const userId = Number(dto.params.id);
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise");
  if(sharedDirectoryClient()){res.json(await directoryAdminUser(pool,req,'admin-user-update',{profile_id:await directoryTargetId(pool,userId),input:dto.body}));return;}
  const user = await adminService.updateUserByAdmin(userId, dto.body, req.user.id);
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  res.json({ user });
});

export const patchAdministrativeLevelAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto=adminAdministrativeLevelSchema.parse({params:req.params,body:req.body});
  if(!sharedDirectoryClient())throw new HttpError(409,'DIRECTORY_AUTHORITY_REQUIRED','Cette modification exige l’annuaire commun.');
  res.setHeader('Cache-Control','no-store');
  res.json(await directoryAdminSuperadmin(pool,req,Number(dto.params.id),dto.body));
});

export const getPrivateUserProfile: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminUserIdParamSchema.parse({ params: req.params });
  // Private HR attributes remain local to the business instance; they are never
  // copied into the common authentication directory.
  const user = await repoGetUserById(Number(dto.params.id), true);
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "Compte introuvable.");
  const userAgent = req.get("User-Agent") ?? null;
  await repoInsertAuditLog({
    user_id: req.user!.id, ip: getClientIp(req), user_agent: userAgent, ...parseDevice(userAgent),
    body: { event_type: "ACTION", action: "PRIVATE_PROFILE_READ", page_key: "administration", entity_type: "user", entity_id: String(user.id), path: req.path, details: { source: "server" } },
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ user_id: user.id, private_profile: { salary: user.salary, date_of_birth: user.date_of_birth, national_id: user.national_id, social_security_number: user.social_security_number } });
});

export const patchPrivateUserProfile: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminUserIdParamSchema.parse({ params: req.params });
  const patch = privateAccountPatchSchema.parse(req.body);
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise.");
  const user = await adminService.updateUserByAdmin(Number(dto.params.id), patch, req.user.id);
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "Compte introuvable.");
  res.setHeader("Cache-Control", "no-store");
  res.json({ user_id: user.id, updated: true });
});

export const createAccountInvitationAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminCreateInvitationSchema.parse({
    headers: { idempotencyKey: req.get("Idempotency-Key") },
    params: req.params,
    body: req.body,
  });
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise");
  const result = sharedDirectoryClient()?await directoryAdminToken(pool,req,'admin-user-invite',{profile_id:await directoryTargetId(pool,Number(dto.params.id)),key:dto.headers.idempotencyKey},Number(dto.params.id)):await adminService.createAccountInvitationByAdmin({
    userId: Number(dto.params.id),
    actorUserId: req.user.id,
    idempotencyKey: dto.headers.idempotencyKey,
  });
  res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
  res.status(result.replayed ? 200 : 201).json(result);
});

export const createPasswordResetTokenAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminCreatePasswordResetSchema.parse({
    headers: { idempotencyKey: req.get("Idempotency-Key") },
    params: req.params,
    body: req.body,
  });
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise");
  const result = sharedDirectoryClient()?await directoryAdminToken(pool,req,'admin-user-reset-token',{profile_id:await directoryTargetId(pool,Number(dto.params.id)),key:dto.headers.idempotencyKey},Number(dto.params.id)):await adminService.createPasswordResetTokenByAdmin({
    userId: Number(dto.params.id),
    actorUserId: req.user.id,
    idempotencyKey: dto.headers.idempotencyKey,
  });
  res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
  res.status(result.replayed ? 200 : 201).json(result);
});

export const resetUserPasswordAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = resetPasswordByAdminSchema.parse({ params: req.params, body: req.body });
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise");
  if(sharedDirectoryClient()){await directoryAdminCall(pool,req,'admin-user-password',{profile_id:await directoryTargetId(pool,Number(dto.params.id)),input:dto.body});res.status(204).end();return;}
  await adminService.resetUserPasswordByAdmin({
    userId: dto.params.id,
    actorUserId: req.user.id,
    token: dto.body.token,
    newPassword: dto.body.newPassword,
  });
  res.status(204).end();
});

export const recoverUserAccountAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminRecoverAccountSchema.parse({ headers: { idempotencyKey: req.get("Idempotency-Key") }, params: req.params, body: req.body });
  const actor = req.user;
  if (actor?.mfa !== true || !actor.mfa_factor_id || typeof actor.mfa_factor_version !== "number" || typeof actor.session_epoch !== "number") {
    throw new HttpError(403, "RECOVERY_MFA_REQUIRED", "Activez et confirmez votre authentification 2FA avant de récupérer un autre compte.");
  }
  const result = sharedDirectoryClient()?await directoryAdminToken(pool,req,'admin-user-recover',{profile_id:await directoryTargetId(pool,Number(dto.params.id)),key:dto.headers.idempotencyKey,input:dto.body},Number(dto.params.id)):await recoverAccountBySuperadmin({
    userId: Number(dto.params.id), actorUserId: actor.id, actorSessionEpoch: actor.session_epoch,
    actorFactorId: actor.mfa_factor_id, actorFactorVersion: actor.mfa_factor_version,
    idempotencyKey: dto.headers.idempotencyKey, reason: dto.body.reason,
    meta: { ip: req.ip ?? null, user_agent: req.get("User-Agent") ?? null, device_type: null, os: null, browser: null,
      path: `/api/v1/admin/users/${dto.params.id}/account-recovery`, request_id: req.requestId ?? null },
  });
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
  res.status(result.replayed ? 200 : 201).json(result);
});

export const getErpSettingAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminErpSettingKeySchema.parse({ params: req.params });
  res.json(await adminService.getErpSetting(dto.params.key));
});

export const upsertErpSettingAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminUpsertErpSettingSchema.parse({ params: req.params, body: req.body });
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise");
  res.json(await adminService.upsertDefaultShippingLocation({
    key: dto.params.key,
    magasinId: dto.body.value_json.magasin_id,
    emplacementId: dto.body.value_json.emplacement_id,
    actorUserId: req.user.id,
  }));
});
