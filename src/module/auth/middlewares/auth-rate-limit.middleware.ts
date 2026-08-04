import type { Request, RequestHandler } from "express";

import type { AuthRateLimitEndpoint } from "../../../config/auth-rate-limit";
import type { AuthRateLimitSubject } from "../domain/auth-rate-limit";
import { authRateLimiter, type AuthRateLimiter } from "../services/auth-rate-limit.service";
import { getRateLimitClientAddress } from "../../../utils/requestMeta";

declare global {
  namespace Express {
    interface Request {
      authRateLimit?: {
        suppressAction: boolean;
        reason: "blocked" | "store-unavailable";
      };
    }
  }
}

type SubjectFactory = (req: Request) => readonly AuthRateLimitSubject[];

const GENERIC_RATE_LIMIT_MESSAGE = "Trop de tentatives. Réessayez plus tard.";
const GENERIC_UNAVAILABLE_MESSAGE = "Service d'authentification temporairement indisponible.";

function bodyString(req: Request, field: string): string | null {
  const body = req.body as Record<string, unknown> | null | undefined;
  const value = body?.[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 512) : null;
}

function safeRequestId(req: Request): string | null {
  const value = req.requestId;
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function subjectsFor(endpoint: AuthRateLimitEndpoint, req: Request): AuthRateLimitSubject[] {
  const ip: AuthRateLimitSubject = { dimension: "ip", value: getRateLimitClientAddress(req) };
  switch (endpoint) {
    case "login":
      return [ip, { dimension: "identifier", value: bodyString(req, "username") }];
    case "register":
      return [
        ip,
        { dimension: "identifier", value: bodyString(req, "username") },
        { dimension: "identifier", value: bodyString(req, "email") },
      ];
    case "forgotPassword":
      return [ip, { dimension: "identifier", value: bodyString(req, "usernameOrEmail") }];
    case "resetPassword":
      return [ip, { dimension: "token", value: bodyString(req, "token") }];
  }
}

function logDecision(req: Request, endpoint: AuthRateLimitEndpoint, event: Record<string, unknown>) {
  console.warn(
    JSON.stringify({
      type: "auth_rate_limit",
      endpoint,
      requestId: safeRequestId(req),
      store: "postgres",
      ...event,
    })
  );
}

export function createAuthRateLimitMiddleware(
  endpoint: AuthRateLimitEndpoint,
  limiter: Pick<AuthRateLimiter, "check"> = authRateLimiter,
  subjectFactory: SubjectFactory = (req) => subjectsFor(endpoint, req)
): RequestHandler {
  return async (req, res, next) => {
    const decision = await limiter.check(endpoint, subjectFactory(req));
    if (decision.status === "allowed") return next();

    if (decision.status === "blocked") {
      logDecision(req, endpoint, {
        outcome: "blocked",
        retryAfterSeconds: decision.retryAfterSeconds,
      });

      if (endpoint === "forgotPassword") {
        req.authRateLimit = { suppressAction: true, reason: "blocked" };
        return next();
      }

      res.setHeader("Retry-After", String(decision.retryAfterSeconds));
      return res.status(429).json({
        error: "TOO_MANY_ATTEMPTS",
        message: GENERIC_RATE_LIMIT_MESSAGE,
      });
    }

    logDecision(req, endpoint, {
      outcome: "store_unavailable",
      policy: decision.failurePolicy,
      retryAfterSeconds: decision.retryAfterSeconds,
      error: decision.errorName,
    });

    if (decision.failurePolicy === "closed-generic") {
      req.authRateLimit = { suppressAction: true, reason: "store-unavailable" };
      return next();
    }

    res.setHeader("Retry-After", String(decision.retryAfterSeconds));
    return res.status(503).json({
      error: "AUTH_TEMPORARILY_UNAVAILABLE",
      message: GENERIC_UNAVAILABLE_MESSAGE,
    });
  };
}

export const registerRateLimit = createAuthRateLimitMiddleware("register");
export const loginRateLimit = createAuthRateLimitMiddleware("login");
export const forgotPasswordRateLimit = createAuthRateLimitMiddleware("forgotPassword");
export const resetPasswordRateLimit = createAuthRateLimitMiddleware("resetPassword");
