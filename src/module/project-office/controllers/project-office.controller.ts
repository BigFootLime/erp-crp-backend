import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../repository/project-office.repository";
import { hasProjectOfficeAccess } from "../services/project-office-access.service";

export function requireUser(req: Request): { id: number; role: string } {
  const user = req.user;
  if (!user || typeof user.id !== "number") throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return { id: user.id, role: typeof user.role === "string" ? user.role : "" };
}

function getClientIp(req: Request): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

function parseDevice(userAgent: string | null): { device_type: string | null; os: string | null; browser: string | null } {
  if (!userAgent) return { device_type: null, os: null, browser: null };
  const ua = userAgent.toLowerCase();
  const device_type = /mobile|android|iphone/.test(ua) ? "mobile" : "desktop";
  const os = /windows/.test(ua) ? "Windows" : /mac os|macintosh/.test(ua) ? "macOS" : /linux/.test(ua) ? "Linux" : /android/.test(ua) ? "Android" : /iphone|ios/.test(ua) ? "iOS" : null;
  const browser = /edg\//.test(ua) ? "Edge" : /chrome\//.test(ua) ? "Chrome" : /firefox\//.test(ua) ? "Firefox" : /safari\//.test(ua) ? "Safari" : null;
  return { device_type, os, browser };
}

export function buildAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const device = parseDevice(userAgent);
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null;
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;
  return {
    user_id: user.id,
    ip: getClientIp(req),
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

// GET /project-office/access — accessible à tout utilisateur AUTHENTIFIÉ (pas de gate ici) :
// répond { project_office: false } au lieu de 403 pour piloter l'affichage de la nav.
export const getAccess = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const ok = await hasProjectOfficeAccess(user.id);
  res.json({ project_office: ok });
});
