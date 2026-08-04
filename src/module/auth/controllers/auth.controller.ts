import { Request, Response } from "express";
import { forgotPasswordSchema, loginSchema, resetPasswordSchema } from "../validators/auth.validator";
import { registerSchema } from "../validators/user.validator";
import { registerUser, loginUser, requestPasswordReset, resetPasswordWithToken } from "../services/auth.service";
import { asyncHandler } from "../../../utils/asyncHandler";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";

export const register = asyncHandler(async (req: Request, res: Response) => {
  const validated = registerSchema.parse(req.body);

  // Sécurité (ISO A.5.15 / A.8.2) : l'inscription publique ne doit JAMAIS permettre
  // l'auto-attribution d'un rôle. Tout `role` fourni par le client est ignoré et forcé
  // à "Employee". La création de comptes avec rôle privilégié passe exclusivement par
  // le module admin (POST /admin/users, protégé par authenticateToken + authorizeRole).
  const user = await registerUser({ ...validated, role: "Employee" });

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

  // Rate-limit anti-bruteforce (A.8.5) : par IP + identifiant, avant toute vérification.
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

const FORGOT_PASSWORD_GENERIC_MESSAGE = "Si ce compte existe, un lien de réinitialisation a été envoyé.";
const FORGOT_PASSWORD_MIN_RESPONSE_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const startedAt = Date.now();

  const ip = getClientIp(req);
  const user_agent = req.headers["user-agent"]?.toString() ?? null;
  const device = parseDevice(user_agent);

  const parsed = forgotPasswordSchema.safeParse(req.body);
  const suppressAction = req.authRateLimit?.suppressAction === true;

  if (!suppressAction && parsed.success) {
    // Fire-and-forget: we don't want email delivery or DB latency to become an enumeration side-channel.
    void requestPasswordReset(parsed.data.usernameOrEmail, {
      request_id: req.requestId ?? null,
      ip,
      user_agent,
      device_type: device.device_type,
      os: device.os,
      browser: device.browser,
    }).catch((e) => {
      // Important: never leak existence; never leak token (not available here).
      console.warn(
        JSON.stringify({
          type: "password_reset_request_failed",
          requestId: req.requestId ?? null,
          path: req.originalUrl,
          error: e instanceof Error ? e.name : "unknown",
        })
      );
    });
  }

  const elapsed = Date.now() - startedAt;
  const wait = FORGOT_PASSWORD_MIN_RESPONSE_MS - elapsed;
  if (wait > 0) await sleep(wait);

  return res.status(200).json({ message: FORGOT_PASSWORD_GENERIC_MESSAGE });
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { token, newPassword } = resetPasswordSchema.parse(req.body);

  const ip = getClientIp(req);
  const user_agent = req.headers["user-agent"]?.toString() ?? null;
  const device = parseDevice(user_agent);

  await resetPasswordWithToken(token, newPassword, {
    ip,
    user_agent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
  });

  return res.status(200).json({ message: "Mot de passe réinitialisé" });
});
