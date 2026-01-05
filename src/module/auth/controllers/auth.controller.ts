import { Request, Response } from "express";
import { loginSchema } from "../validators/auth.validator";
import { registerSchema } from "../validators/user.validator";
import { registerUser, loginUser } from "../services/auth.service";
import { asyncHandler } from "../../../utils/asyncHandler";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";

export const register = asyncHandler(async (req: Request, res: Response) => {
  const validated = registerSchema.parse(req.body);

  const user = await registerUser(validated);

  return res.status(201).json({
    message: "Utilisateur créé avec succès",
    user,
  });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = loginSchema.parse(req.body);

  const ip = getClientIp(req);
  const user_agent = req.headers["user-agent"]?.toString() ?? null;
  const device = parseDevice(user_agent);

  const data = await loginUser(username, password, {
    ip,
    user_agent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
  });

  return res.status(200).json({
    message: "Connexion réussie",
    ...data,
  });
});
