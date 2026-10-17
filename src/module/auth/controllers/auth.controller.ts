import { Request, Response } from "express";
import {
  activateAccountSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
} from "../validators/auth.validator";
import {
  activateAccountWithInvitation,
  loginUser,
  requestPasswordReset,
  resetPasswordWithToken,
} from "../services/auth.service";
import { asyncHandler } from "../../../utils/asyncHandler";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import { HttpError } from "../../../utils/httpError";
import pool from '../../../config/database';
import {sharedDirectoryClient,directoryAuthenticationResult} from '../../../shared-directory/site-runtime';

function mapDirectoryLoginFailure(error: unknown): never {
  const candidate = error as { code?: unknown; status?: unknown } | null;
  if (candidate?.code === "AUTH_INVALID") {
    throw new HttpError(401, "AUTH_INVALID", "Identifiants invalides");
  }
  if (candidate?.status === 429) {
    throw new HttpError(429, "TOO_MANY_ATTEMPTS", "Trop de tentatives. Réessayez plus tard.");
  }
  // A configured Directory remains authoritative. Any other Directory response,
  // transport failure, or malformed response must not become a local login path
  // or disclose the upstream error to the caller.
  throw new HttpError(503, "DIRECTORY_UNAVAILABLE", "L’annuaire est momentanément indisponible.");
}

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = loginSchema.parse(req.body);

  const ip = getClientIp(req);
  const user_agent = req.headers["user-agent"]?.toString() ?? null;
  const device = parseDevice(user_agent);

  // Rate-limit anti-bruteforce (A.8.5) : par IP + identifiant, avant toute vérification.
  const meta={
    ip,
    user_agent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
  };
  const directory=sharedDirectoryClient();
  let data;
  try {
    data=directory ? await directoryAuthenticationResult(pool,await directory.call('login',{input:{username,password},meta}),meta):await loginUser(username,password,meta);
  } catch (error) {
    if (directory) mapDirectoryLoginFailure(error);
    throw error;
  }

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
    const directory=sharedDirectoryClient();
    const action=directory?directory.call('password-forgot',{input:parsed.data,meta:{ip,user_agent,device_type:device.device_type,os:device.os,browser:device.browser}}):requestPasswordReset(parsed.data.usernameOrEmail, {
      request_id: req.requestId ?? null,
      ip,
      user_agent,
      device_type: device.device_type,
      os: device.os,
      browser: device.browser,
    });
    void action.catch((e) => {
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

  const meta={
    ip,
    user_agent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
  };

  const directory=sharedDirectoryClient();
  if(directory)await directory.call('password-reset',{input:{token,newPassword},meta});
  else await resetPasswordWithToken(token,newPassword,meta);
  return res.status(200).json({ message: "Mot de passe réinitialisé" });
});

export const activateAccount = asyncHandler(async (req: Request, res: Response) => {
  const { token, newPassword } = activateAccountSchema.parse(req.body);
  const user_agent = req.headers["user-agent"]?.toString() ?? null;
  const device = parseDevice(user_agent);
  const meta={
    ip: getClientIp(req),
    user_agent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
  };
  const directory=sharedDirectoryClient();
  const result=directory?await directory.call<{replayed:boolean}>('account-activate',{input:{token,newPassword},meta}):await activateAccountWithInvitation(token,newPassword,meta);
  res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
  return res.status(200).json({
    message: result.replayed ? "Compte déjà activé" : "Compte activé",
    replayed: result.replayed,
  });
});
