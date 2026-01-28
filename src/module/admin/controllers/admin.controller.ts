// src/module/admin/controllers/admin.controller.ts
import { Request, RequestHandler, Response } from "express";
import * as adminService from "../services/admin.service";
import { resetPasswordByAdminSchema } from "../validators/admin.validators";

export async function listUsersAdmin(req: Request, res: Response): Promise<void> {
  const rows = await adminService.listUsers();
  res.json(rows);
}

export async function listLoginLogsAdmin(req: Request, res: Response): Promise<void> {
  const from = (req.query.from as string) || "";
  const to = (req.query.to as string) || "";
  const success = (req.query.success as string) || ""; // "true" | "false" | ""
  const username = (req.query.username as string) || "";

  const rows = await adminService.listLoginLogs({ from, to, success, username });
  res.json(rows);
}

export async function getAdminAnalytics(req: Request, res: Response): Promise<void> {
  const from = (req.query.from as string) || "";
  const to = (req.query.to as string) || "";
  const success = (req.query.success as string) || "";
  const role = (req.query.role as string) || "";
  const status = (req.query.status as string) || "";

  const data = await adminService.getAnalytics({ from, to, success, role, status });
  res.json(data);
}

export const resetUserPasswordAdmin: RequestHandler = async (req, res, next) => {
  try {
    // validate like your modules do
    const dto = resetPasswordByAdminSchema.parse({
      params: req.params,
      body: req.body,
    });

    const userId = dto.params.id;

    await adminService.resetUserPasswordByAdmin({
      userId,
      token: dto.body.token,
      newPassword: dto.body.newPassword,
      // if you already store req.user in auth middleware:
      // adminId: (req as any).user?.id ?? null,
    });

    res.status(204).end();
  } catch (e) {
    next(e);
  }
};
