import type { RequestHandler } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import * as adminService from "../services/admin.service";
import {
  adminCreateUserSchema,
  adminCreateInvitationSchema,
  adminCreatePasswordResetSchema,
  adminUpdateUserSchema,
  adminUserIdParamSchema,
  resetPasswordByAdminSchema,
} from "../validators/admin.validators";

export const listUsersAdmin: RequestHandler = asyncHandler(async (_req, res) => {
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
  const user = await adminService.getUser(Number(dto.params.id));
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  res.json({ user });
});

export const createUserAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminCreateUserSchema.parse({
    headers: { idempotencyKey: req.get("Idempotency-Key") },
    body: req.body,
  });
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise");

  const result = await adminService.createUserByAdmin({
    ...dto.body,
    actorUserId: req.user.id,
    idempotencyKey: dto.headers.idempotencyKey,
  });
  res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
  res.status(result.replayed ? 200 : 201).json(result);
});

export const patchUserAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminUpdateUserSchema.parse({ params: req.params, body: req.body });
  const userId = Number(dto.params.id);
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise");
  const user = await adminService.updateUserByAdmin(userId, dto.body, req.user.id);
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  res.json({ user });
});

export const createAccountInvitationAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminCreateInvitationSchema.parse({
    headers: { idempotencyKey: req.get("Idempotency-Key") },
    params: req.params,
    body: req.body,
  });
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise");
  const result = await adminService.createAccountInvitationByAdmin({
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
  const result = await adminService.createPasswordResetTokenByAdmin({
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
  await adminService.resetUserPasswordByAdmin({
    userId: dto.params.id,
    actorUserId: req.user.id,
    token: dto.body.token,
    newPassword: dto.body.newPassword,
  });
  res.status(204).end();
});
