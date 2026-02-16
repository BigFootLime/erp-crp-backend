// src/module/admin/controllers/admin.controller.ts
import type { RequestHandler } from "express";
import * as adminService from "../services/admin.service";
import {
  adminCreateUserSchema,
  adminUpdateUserSchema,
  adminUserIdParamSchema,
  resetPasswordByAdminSchema,
} from "../validators/admin.validators";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";

export const listUsersAdmin: RequestHandler = asyncHandler(async (_req, res) => {
  const rows = await adminService.listUsers();
  res.json(rows);
});

export const listLoginLogsAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const from = (req.query as { from?: unknown }).from;
  const to = (req.query as { to?: unknown }).to;
  const success = (req.query as { success?: unknown }).success;
  const username = (req.query as { username?: unknown }).username;

  const rows = await adminService.listLoginLogs({
    from: typeof from === "string" ? from : "",
    to: typeof to === "string" ? to : "",
    success: typeof success === "string" ? success : "",
    username: typeof username === "string" ? username : "",
  });
  res.json(rows);
});

export const getAdminAnalytics: RequestHandler = asyncHandler(async (req, res) => {
  const from = (req.query as { from?: unknown }).from;
  const to = (req.query as { to?: unknown }).to;
  const success = (req.query as { success?: unknown }).success;
  const role = (req.query as { role?: unknown }).role;
  const status = (req.query as { status?: unknown }).status;

  const data = await adminService.getAnalytics({
    from: typeof from === "string" ? from : "",
    to: typeof to === "string" ? to : "",
    success: typeof success === "string" ? success : "",
    role: typeof role === "string" ? role : "",
    status: typeof status === "string" ? status : "",
  });
  res.json(data);
});

export const getUserAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminUserIdParamSchema.parse({ params: req.params });
  const userId = Number(dto.params.id);
  const user = await adminService.getUser(userId);
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  res.json({ user });
});

export const createUserAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminCreateUserSchema.parse({ body: req.body });
  const user = await adminService.createUserByAdmin({
    username: dto.body.username,
    password: dto.body.password,
    name: dto.body.name,
    surname: dto.body.surname,
    email: dto.body.email,
    tel_no: dto.body.tel_no,
    role: dto.body.role,
    gender: dto.body.gender,
    address: dto.body.address,
    lane: dto.body.lane,
    house_no: dto.body.house_no,
    postcode: dto.body.postcode,
    country: dto.body.country ?? "France",
    salary: dto.body.salary === undefined ? null : dto.body.salary,
    date_of_birth: dto.body.date_of_birth,
    employment_date: dto.body.employment_date ?? null,
    employment_end_date: dto.body.employment_end_date ?? null,
    national_id: dto.body.national_id ?? null,
    status: dto.body.status ?? null,
    social_security_number: dto.body.social_security_number,
  });
  res.status(201).json({ user });
});

export const patchUserAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminUpdateUserSchema.parse({ params: req.params, body: req.body });
  const userId = Number(dto.params.id);
  const user = await adminService.updateUserByAdmin(userId, dto.body);
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  res.json({ user });
});

export const deleteUserAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminUserIdParamSchema.parse({ params: req.params });
  const userId = Number(dto.params.id);
  const ok = await adminService.deleteUserByAdmin(userId);
  if (!ok) throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  res.status(204).end();
});

export const createPasswordResetTokenAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = adminUserIdParamSchema.parse({ params: req.params });
  const userId = Number(dto.params.id);
  const out = await adminService.createPasswordResetTokenByAdmin({ userId });
  res.status(201).json(out);
});

export const resetUserPasswordAdmin: RequestHandler = asyncHandler(async (req, res) => {
  const dto = resetPasswordByAdminSchema.parse({
    params: req.params,
    body: req.body,
  });

  await adminService.resetUserPasswordByAdmin({
    userId: dto.params.id,
    token: dto.body.token,
    newPassword: dto.body.newPassword,
  });

  res.status(204).end();
});
