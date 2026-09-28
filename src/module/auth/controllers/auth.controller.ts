import { NextFunction, Request, Response } from "express";
import {
  activateAccountSchema,
  forgotPasswordSchema,
  type LoginDTO,
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
import { isDemoMode } from "../../../config/demo-mode";
import { HttpError } from "../../../utils/httpError";

function selectedDatabase(req: Request): string | undefined {
  return typeof req.headers["x-cerp-database"] === "string"
    ? req.headers["x-cerp-database"]
    : undefined;
}

async function respondWithLogin(
  req: Request,
  res: Response,
  credentials: Pick<LoginDTO, "username" | "password">,
) {
  const { username, password } = credentials;

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
}

export const login = asyncHandler(async (req: Request, res: Response) => {
  const database = selectedDatabase(req);
  const parsed = loginSchema.parse({
    ...req.body,
    database: isDemoMode() ? database : req.body?.database ?? database,
  });
  return respondWithLogin(req, res, parsed);
});

function demoCredential(name: "DEMO_SEED_USERNAME" | "DEMO_SEED_PASSWORD"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new HttpError(503, "DEMO_UNAVAILABLE", "La démonstration est temporairement indisponible.");
  }
  return value;
}

/**
 * Server-only visitor login for the isolated CERP demo. The credentials are
 * deliberately never read from the request and this delegates to the normal
 * password login flow, preserving its JWT, account-state and audit checks.
 */
export const demoLogin = asyncHandler(async (req: Request, res: Response) => {
  if (!isDemoMode()) {
    throw new HttpError(404, "NOT_FOUND", "Route introuvable.");
  }
  const credentials = loginSchema.parse({
    username: `${demoCredential("DEMO_SEED_USERNAME")}${req.body?.persona === "quality-reviewer" ? "_QUALITE" : ""}`,
    password: demoCredential("DEMO_SEED_PASSWORD"),
    database: selectedDatabase(req),
  });
  return respondWithLogin(req, res, credentials);
});

/** Places the server-only visitor identity into the existing login limiter. */
export function demoLoginRateLimitIdentity(req: Request, res: Response, next: NextFunction): void {
  if (!isDemoMode()) {
    res.sendStatus(404);
    return;
  }
  req.body = { ...(req.body ?? {}), username: process.env.DEMO_SEED_USERNAME?.trim() || "DEMO" };
  next();
}

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

export const activateAccount = asyncHandler(async (req: Request, res: Response) => {
  const { token, newPassword } = activateAccountSchema.parse(req.body);
  const user_agent = req.headers["user-agent"]?.toString() ?? null;
  const device = parseDevice(user_agent);
  const result = await activateAccountWithInvitation(token, newPassword, {
    ip: getClientIp(req),
    user_agent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
  });
  res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
  return res.status(200).json({
    message: result.replayed ? "Compte déjà activé" : "Compte activé",
    replayed: result.replayed,
  });
});
